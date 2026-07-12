/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The RESOLVED-address → Nominatim-schema formatter: rendering a {@link ResolvedAddress} into a
 *   {@link NominatimResult} (`toNominatimResult`), the `format=geojson` FeatureCollection envelope
 *   (`toFeatureCollection`), and the `format=jsonld` schema.org projection
 *   (`nominatimResultToSchemaOrg`). Wire types + the engine contract live in `engine.ts`.
 */

import { composeStreetAddress, type SchemaOrgPlace, toSchemaOrg } from "@mailwoman/annotations"

import type { NominatimAddressDetails, NominatimResult } from "./engine.ts"

/** A GeoJSON `FeatureCollection` — the `format=geojson` envelope. */
export interface NominatimFeatureCollection {
	type: "FeatureCollection"
	features: Array<{
		type: "Feature"
		properties: Record<string, unknown>
		geometry: unknown
		bbox?: [number, number, number, number]
	}>
}

/**
 * Render results as a GeoJSON `FeatureCollection` (`format=geojson`). Nominatim moves the coordinate into `geometry` (a
 * Point, or the place polygon when one is present), `boundingbox` ([south, north, west, east]) into a GeoJSON `bbox`
 * ([west, south, east, north]), and the remaining result fields into `properties`. Rows without a coordinate are
 * dropped — a Feature needs a geometry.
 */
export function toFeatureCollection(results: readonly NominatimResult[]): NominatimFeatureCollection {
	const features: NominatimFeatureCollection["features"] = []

	for (const r of results) {
		if (r.lat == null || r.lon == null) continue
		const { lat, lon, boundingbox, geojson, ...properties } = r
		const feature: NominatimFeatureCollection["features"][number] = {
			type: "Feature",
			properties,
			geometry: geojson ?? { type: "Point", coordinates: [Number(lon), Number(lat)] },
		}

		if (boundingbox?.length === 4) {
			// boundingbox is [south, north, west, east]; GeoJSON bbox is [west, south, east, north].
			feature.bbox = [Number(boundingbox[2]), Number(boundingbox[0]), Number(boundingbox[3]), Number(boundingbox[1])]
		}
		features.push(feature)
	}

	return { type: "FeatureCollection", features }
}

/**
 * A resolved address in a neutral shape, the input to {@link toNominatimResult}. The engine maps its native
 * geocode/reverse result into this; the formatter renders it as a Nominatim result. This is the #804 mapping seam, kept
 * dependency-free (no `@mailwoman/*` import) so it stays unit-testable.
 */
export interface ResolvedAddress {
	lat: number | null
	lon: number | null
	address: NominatimAddressDetails
	/** Pre-rendered display name; falls back to the address values joined by ", ". */
	displayName?: string
	category?: string
	type?: string
	importance?: number
	placeRank?: number
	boundingbox?: [string, string, string, string]
	/** A stable id from the resolver (WOF/GERS); a deterministic hash is used when absent. */
	placeID?: string | number
}

/** The attribution string emitted as `licence` (the data sources Mailwoman resolves over). */
export const MAILWOMAN_LICENCE = "Data © Who's On First, Overture Maps, OpenAddresses, US Census TIGER"

function stableID(seed: string): number {
	let h = 5381

	for (let i = 0; i < seed.length; i++) {
		h = (h * 33) ^ seed.charCodeAt(i)
	}

	return h >>> 0
}

/**
 * Render a {@link ResolvedAddress} as a Nominatim result. `addressdetails` gates the `address` block, matching
 * Nominatim. The `annotations` block is attached by the caller (empty until the annotations layer lands).
 */
export function toNominatimResult(r: ResolvedAddress, opts: { addressdetails?: boolean } = {}): NominatimResult {
	const displayName = r.displayName ?? Object.values(r.address).filter(Boolean).join(", ")
	const lat = r.lat != null ? String(r.lat) : ""
	const lon = r.lon != null ? String(r.lon) : ""
	const result: NominatimResult = {
		place_id: r.placeID ?? stableID(`${lat},${lon},${displayName}`),
		licence: MAILWOMAN_LICENCE,
		lat,
		lon,
		display_name: displayName,
	}

	if (r.category != null) {
		result.class = r.category
	}

	if (r.type != null) {
		result.type = r.type
	}

	if (r.importance != null) {
		result.importance = r.importance
	}

	if (r.placeRank != null) {
		result.place_rank = r.placeRank
	}

	if (r.boundingbox) {
		result.boundingbox = r.boundingbox
	}

	if (opts.addressdetails) {
		result.address = r.address
	}

	return result
}

/**
 * Project a Nominatim result into a schema.org `Place` JSON-LD object (`format=jsonld`, #1052) — the OUTPUT-format
 * projection. Reads the result's `address` breakdown (populated because the router forces `addressdetails` for
 * `jsonld`) plus the coordinate, re-serializing the SAME resolved place. `streetAddress` is the plain
 * house-number-first join (house_number + road); `addressCountry` is ISO-3166 alpha-2 (uppercased).
 */
export function nominatimResultToSchemaOrg(r: NominatimResult): SchemaOrgPlace {
	const a = r.address ?? {}
	const streetAddress = composeStreetAddress({ houseNumber: a.house_number, street: a.road })

	return toSchemaOrg({
		lat: r.lat ? Number(r.lat) : null,
		lon: r.lon ? Number(r.lon) : null,
		streetAddress: streetAddress || undefined,
		locality: a.city ?? a.town ?? a.village,
		region: a.state,
		postalCode: a.postcode,
		countryCode: a.country_code,
	})
}
