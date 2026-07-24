/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The RESOLVED-place → Photon-schema projection: decorating a resolved gazetteer place (proper-
 *   cased names + ancestry + country, house/street grade overrides) into {@link PhotonProperties},
 *   plus the `format=jsonld` schema.org re-serialization. Wire types + feature/collection
 *   construction live in `engine.ts`.
 */

import { composeStreetAddress, type SchemaOrgPlace, toSchemaOrg } from "@mailwoman/annotations"

import {
	type PhotonFeature,
	type PhotonFeatureCollection,
	photonCollection,
	photonFeature,
	type PhotonProperties,
} from "./engine.ts"

/**
 * The resolved-place info a forward `/api` result carries: the admin ladder (MOST-SPECIFIC first) with GAZETTEER names,
 * the coordinate, the resolved country, and the postcode. {@link photonForwardProperties} projects it onto Photon's
 * schema. #1014 — decorate from the resolved place, not the parsed input span.
 */
export interface PhotonForwardInput {
	lat: number
	lon: number
	postcode?: string | null
	/** The resolved country, mapped by the caller (ISO2 → canonical name via `@mailwoman/codex`). */
	country?: { name?: string; code?: string } | null
	/** Resolved admin ancestry, most-specific first, each carrying the gazetteer's canonical name (not the parsed span). */
	places: ReadonlyArray<{ tag: string; name: string }>
	/**
	 * A HOUSE-GRADE result (#1041): set only when the resolver produced a specific building coordinate — the
	 * `address_point` (rooftop) or `interpolated` tier fired, NOT an admin centroid. {@link photonForwardProperties} then
	 * re-tags the schema `osm_key: place` / `osm_value: house` / `type: house` and surfaces the parsed `housenumber` +
	 * `street`, matching upstream komoot/photon's own bare-address-point shape (verified against `photon.komoot.io`: a
	 * residential rooftop returns `{osm_key:"place", osm_value:"house", type:"house", housenumber, street}` with NO
	 * `name`). Absent → the result keeps its admin-ancestry schema. Without it a rooftop reads as `type: city` and a
	 * client zooms to city scale (or paints a city marker) on a doorstep match — the #1041 regression.
	 */
	house?: { number?: string | null; street?: string | null } | null
	/**
	 * A STREET-GRADE result (#1050): set when the street-centroid tier (#1042/#1046) fired — a street-level coordinate,
	 * below rooftop/interp, above admin. {@link photonForwardProperties} re-tags it `osm_key: highway` / `osm_value:
	 * residential` / `type: street` with the FULL assembled street name in `name` — matching upstream komoot's street
	 * results (verified live 2026-07-10: a street primary returns `{osm_key:"highway", osm_value:<class>, type:"street",
	 * name:"Rue de la République", city, …}`; the street name rides `name`, not `street`). Without it a street centroid
	 * reads `type: city` with the city's name — the #1050 regression. `house` wins when both are set (a numbered query
	 * never street-tiers).
	 */
	street?: { name?: string | null } | null
}

/**
 * How a resolved tag projects onto Photon's schema: the property key that holds its name, plus the OSM `key`/`value`/
 * `type` a Photon client reads. Kept close to komoot Photon's own values so client label-builders behave.
 */
const FORWARD_TAG_PROJECTION: Record<
	string,
	{ key: keyof PhotonProperties; osmKey: string; osmValue: string; type: string }
> = {
	venue: { key: "name", osmKey: "amenity", osmValue: "yes", type: "house" },
	house: { key: "name", osmKey: "building", osmValue: "yes", type: "house" },
	street: { key: "street", osmKey: "highway", osmValue: "residential", type: "street" },
	neighbourhood: { key: "district", osmKey: "place", osmValue: "suburb", type: "district" },
	// The finest tier the /reverse descent ladder (resolver-wof-sqlite `DESCENT_TIERS`) can return — without a row
	// here a microhood-deepest reverse result fell through to the `place/yes/other` default. #1041 close-out.
	microhood: { key: "district", osmKey: "place", osmValue: "neighbourhood", type: "district" },
	dependent_locality: { key: "district", osmKey: "place", osmValue: "suburb", type: "district" },
	borough: { key: "district", osmKey: "place", osmValue: "borough", type: "district" },
	locality: { key: "city", osmKey: "place", osmValue: "city", type: "city" },
	// WOF placetypes the /reverse hierarchy uses (so both endpoints derive osm tags from ONE table).
	localadmin: { key: "city", osmKey: "place", osmValue: "city", type: "city" },
	subregion: { key: "county", osmKey: "place", osmValue: "county", type: "county" },
	county: { key: "county", osmKey: "place", osmValue: "county", type: "county" },
	region: { key: "state", osmKey: "place", osmValue: "state", type: "state" },
	macroregion: { key: "state", osmKey: "place", osmValue: "state", type: "state" },
	country: { key: "country", osmKey: "place", osmValue: "country", type: "country" },
}

/** Fallback OSM tags — a Photon client reads `osm_key`/`osm_value`/`type` unconditionally, so they must never be absent. */
const DEFAULT_OSM_TAGS = { osm_key: "place", osm_value: "yes", type: "other" } as const

/**
 * The Photon `osm_key`/`osm_value`/`type` for a resolved tag or WOF placetype (`locality`, `region`, `country`, …),
 * falling back to a safe default so the fields are always present. Shared by the forward projection and `/reverse` so
 * the two endpoints report a place the SAME way. #1014.
 */
export function photonOSMTags(tagOrPlacetype: string): { osm_key: string; osm_value: string; type: string } {
	const proj = FORWARD_TAG_PROJECTION[tagOrPlacetype]

	return proj ? { osm_key: proj.osmKey, osm_value: proj.osmValue, type: proj.type } : { ...DEFAULT_OSM_TAGS }
}

/**
 * Project a resolved forward result into Photon properties — decorating from the RESOLVED gazetteer place (proper-cased
 * names + ancestry + country), NOT the parsed input span, and ALWAYS emitting `osm_key`/`osm_value`/`type` so Photon
 * client libraries (leaflet-control-geocoder, @openrunner/photon-geocoder) never dereference undefined. #1014.
 */
export function photonForwardProperties(input: PhotonForwardInput): PhotonProperties {
	// Safe defaults: a Photon client reads osm_key/osm_value/type unconditionally, so they must never be undefined.
	const props: PhotonProperties = { ...DEFAULT_OSM_TAGS }
	const [primary] = input.places

	if (primary) {
		props.name = primary.name
		Object.assign(props, photonOSMTags(primary.tag))
	}

	for (const place of input.places) {
		const proj = FORWARD_TAG_PROJECTION[place.tag]

		if (proj && props[proj.key] == null) {
			props[proj.key] = place.name
		}
	}

	if (input.postcode) {
		props.postcode = input.postcode
	}

	if (input.country?.name && props.country == null) {
		props.country = input.country.name
	}

	if (input.country?.code) {
		props.countrycode = input.country.code.toLowerCase()
	}

	// #1041: house-grade override. A rooftop / interpolated coordinate is a BUILDING, not the admin locality the
	// ancestry above would label it — re-tag the schema so a Photon client renders (and zooms to) a house, and surface
	// the parsed housenumber + street. Matches upstream komoot/photon's bare address point (osm_key:place, osm_value:
	// house, type:house, with housenumber + street and NO name). Drop the admin-derived `name` — else the QGIS FLF label
	// (name + housenumber + street + city + postcode) doubles the city ("Paris 8 Boulevard du Palais Paris 75001"). The
	// city/state/postcode/country the ancestry filled stay put (upstream carries them on a house result too).
	// #1050: street-grade — the street-centroid tier fired. Re-tag per upstream's street shape (full
	// name in `name`, highway/street osm tags); the admin ancestry (city/state/…) stays as context.
	if (input.street?.name && !input.house) {
		props.name = input.street.name
		Object.assign(props, { osm_key: "highway", osm_value: "residential", type: "street" })
	}

	if (input.house) {
		props.osm_key = "place"
		props.osm_value = "house"
		props.type = "house"
		delete props.name
		const number = input.house.number?.trim()
		const street = input.house.street?.trim()

		if (number) {
			props.housenumber = number
		}

		if (street) {
			props.street = street
		}
	}

	return props
}

/** {@link photonForwardProperties}, wrapped as a Photon Point `Feature` at the resolved coordinate. #1014. */
export function photonForwardFeature(input: PhotonForwardInput): PhotonFeature {
	return photonFeature(input.lon, input.lat, photonForwardProperties(input))
}

/** The winning place plus its ranked alternatives — the input to {@link photonForwardCollection}. #1016. */
export interface PhotonForwardResult {
	/** The winning place, with full admin ancestry (from the resolved hierarchy). */
	primary: PhotonForwardInput
	/** Ranked alternative places (Springfield MA / IL / …), each a single-place input; excludes the primary. */
	alternatives: PhotonForwardInput[]
}

/**
 * Assemble a Photon `FeatureCollection` honoring `limit` (#1016): the primary feature first, then ranked alternatives,
 * capped at `limit`. `limit` floors to 1 (Photon always returns at least the best match).
 */
export function photonForwardCollection(result: PhotonForwardResult, limit: number): PhotonFeatureCollection {
	const cap = Math.max(1, Math.floor(limit) || 1)
	const features = [photonForwardFeature(result.primary)]

	for (const alt of result.alternatives) {
		if (features.length >= cap) break
		features.push(photonForwardFeature(alt))
	}

	return photonCollection(features)
}

/**
 * Project a Photon `Feature` into a schema.org `Place` JSON-LD object (`format=jsonld`, #1052) — the OUTPUT-format
 * projection. Reads the feature's already-decorated {@link PhotonProperties} (housenumber/street/city/state/postcode/
 * countrycode + the coordinate), so it stays a pure re-serialization of the SAME resolved place the FeatureCollection
 * carries. `streetAddress` is the plain house-number-first join (the light router has no locale formatter).
 */
export function photonFeatureToSchemaOrg(feature: PhotonFeature): SchemaOrgPlace {
	const p = feature.properties
	const [lon, lat] = feature.geometry.coordinates
	const streetAddress = composeStreetAddress({ houseNumber: p.housenumber, street: p.street })

	return toSchemaOrg({
		lat,
		lon,
		name: p.name,
		streetAddress: streetAddress || undefined,
		locality: p.city,
		region: p.state,
		postalCode: p.postcode,
		countryCode: p.countrycode,
	})
}

/** Project a whole Photon `FeatureCollection` into an array of schema.org `Place` objects (`format=jsonld`). #1052. */
export function photonToSchemaOrg(collection: PhotonFeatureCollection): SchemaOrgPlace[] {
	return collection.features.map(photonFeatureToSchemaOrg)
}
