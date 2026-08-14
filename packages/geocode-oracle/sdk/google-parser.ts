/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Google Geocoding result → mailwoman {@linkcode OracleGeocodeResult}. This is the DOMAIN half of
 *   the isp-nexus port; everything else in this workspace is plumbing that was rewritten rather than
 *   carried over.
 *
 *   What was salvaged from `isp-nexus/universe/mailwoman/sdk/google/parser.ts`: the idea of indexing
 *   `address_components` by type once instead of re-scanning the array per field, and the
 *   `location_type` → accuracy-tier mapping. What was NOT:
 *
 *     1. **The uppercasing.** The original's `getShortName`/`getLongName` both ended in
 *        `.toUpperCase()`, because it was serving a USPS-shaped US-only pipeline where uppercase IS the
 *        postal form. This oracle exists to canonicalize gauntlet cases across ~160 COUNTRIES, where
 *        the same call turns `Köln` into `KÖLN`, `Île-de-France` into `ÎLE-DE-FRANCE`, and every CJK or
 *        Cyrillic name into itself with the reader's confidence quietly damaged. Casing is preserved
 *        exactly as Google returns it.
 *     2. **The US state-code prefix.** `AdminLevel1Code[adminLevel1] || "ZZ"` fed a US FIPS lookup that
 *        yields `"ZZ"` for every non-US address — i.e. a constant. `@mailwoman/address-id` derives its
 *        own prefix (or `xx`), so the whole path is gone.
 *     3. **The nine-significant-digit round.** `parseFloat(lat.toPrecision(9))` was applied to both
 *        axes. Google returns seven decimal places; nine significant digits keeps all of them for a
 *        two-digit latitude and drops the last for a three-digit longitude, so the round was
 *        asymmetric between hemispheres and bought nothing. Coordinates pass through untouched.
 *
 *   THE COMPONENT MAPPING IS THE JUDGEMENT CALL, and {@linkcode OracleGeocodeResult.raw} is the escape
 *   hatch that keeps it from being lossy. See {@linkcode COMPONENT_RULES} for the ordering rule and
 *   {@linkcode REGION_ABBREVIATION_COUNTRIES} for the one place a country-conditional choice is made.
 */

import { createPostalAddressID } from "@mailwoman/address-id"
import type { ComponentDict } from "@mailwoman/formatter"
import { type AddressGeocode, type ResolutionTier, toPostalAddress, withGeocode } from "@mailwoman/record"

import { OracleProvider, type OracleGeocodeResult, regionPrefix } from "../result.ts"
import {
	type GoogleAddressComponent,
	type GoogleGeocodeResult,
	GoogleLocationType,
	type GoogleLatLngLiteral,
} from "./google-types.ts"

/**
 * Which half of a component to take: Google's expanded text or its abbreviation.
 */
type NameForm = "long" | "short"

/**
 * One mapping rule: any of `types` on a component claims `tag`, taking `form`.
 */
interface ComponentRule {
	types: string[]
	tag: keyof ComponentDict
	form: NameForm
}

/**
 * The component-type → `ComponentTag` table, IN PRIORITY ORDER. Two independent first-writer-wins rules apply as it is
 * walked, and both are load-bearing:
 *
 * 1. **A tag is written once.** A later rule for an already-filled tag is skipped.
 * 2. **A component is consumed once.** A component that already claimed a tag cannot claim a second one.
 *
 * Rule 2 is what makes the two `locality` entries below correct rather than a duplication bug, and the case it exists
 * for is Great Britain. Google returns a GB address as `postal_town: "London"` plus, frequently, a `locality` holding
 * the district (`"Shoreditch"`). The post town is what a GB postal address puts on the locality line, so `postal_town`
 * is listed first and takes `locality`; the district component then falls through to `dependent_locality`, which is
 * exactly the tag mailwoman's GB work uses for it. In a country with no `postal_town` the first `locality` rule fires,
 * consumes the component, and the second one finds nothing left to place — so no country gets its locality written into
 * two tags.
 *
 * Deliberately unmapped, and available on `raw`: `political` (a modifier that co-occurs with everything and names
 * nothing), `administrative_area_level_3` and below (which is a comune in Italy, a ward in Japan, and a
 * census-designated nothing in the United States — no single tag survives that), `postal_code_prefix`, and every
 * `plus_code`-derived pseudo-component.
 */
const COMPONENT_RULES: readonly ComponentRule[] = [
	{ types: ["street_number"], tag: "house_number", form: "short" },
	{ types: ["route"], tag: "street", form: "long" },
	// Google splits a unit designator across three types depending on how the address was written.
	// Any of them is the unit line; the first one present wins.
	{ types: ["subpremise"], tag: "unit", form: "short" },
	{ types: ["room"], tag: "unit", form: "short" },
	{ types: ["floor"], tag: "unit", form: "short" },
	{ types: ["post_box"], tag: "po_box", form: "short" },
	// A named building or business. `premise` is the building itself; the POI types are what a query
	// like "Eiffel Tower" comes back as.
	{ types: ["premise"], tag: "venue", form: "long" },
	{ types: ["point_of_interest", "establishment"], tag: "venue", form: "long" },
	{ types: ["postal_code"], tag: "postcode", form: "long" },
	{ types: ["postal_town"], tag: "locality", form: "long" },
	{ types: ["locality"], tag: "locality", form: "long" },
	{ types: ["sublocality", "sublocality_level_1"], tag: "dependent_locality", form: "long" },
	{ types: ["neighborhood"], tag: "dependent_locality", form: "long" },
	// The GB fall-through described in this table's docstring. Unreachable unless `postal_town`
	// already took the `locality` tag.
	{ types: ["locality"], tag: "dependent_locality", form: "long" },
	{ types: ["administrative_area_level_2"], tag: "subregion", form: "long" },
	// `region` takes its form from the country — see REGION_ABBREVIATION_COUNTRIES. The `form` here is
	// the fallback used when the country is unknown.
	{ types: ["administrative_area_level_1"], tag: "region", form: "long" },
	{ types: ["country"], tag: "country", form: "short" },
]

/**
 * The countries whose written postal convention puts the first-level subdivision in its ABBREVIATED form, so
 * `administrative_area_level_1` is taken from `short_name` there and `long_name` everywhere else.
 *
 * The list is short on purpose. An abbreviation is the conventional written form in these five and almost nowhere else:
 * a French address writes `Île-de-France`, not `IDF`; a German one writes `Nordrhein-Westfalen`, not `NW`; Google has a
 * `short_name` for both regardless, and taking it would produce a `region` no parser will ever see in real input. The
 * United States, Canada, Australia, Mexico and Brazil are the cases where the opposite is true — `NY`, `ON`, `NSW`,
 * `JAL`, `SP` are what appears on the envelope.
 *
 * WHEN THIS IS WRONG FOR YOUR CASE, read `raw.address_components` — both forms are always there. This is a default that
 * makes the common case right, not a claim about postal law.
 */
const REGION_ABBREVIATION_COUNTRIES = new Set(["US", "CA", "AU", "MX", "BR"])

/**
 * Index every component by every type it carries, so a lookup is a map probe rather than a scan of the array. A
 * component tagged both `locality` and `political` is reachable under either key and is the SAME object under both,
 * which is what lets {@linkcode buildGoogleComponents} consume it once.
 */
function indexByType(components: readonly GoogleAddressComponent[]): Map<string, GoogleAddressComponent> {
	const index = new Map<string, GoogleAddressComponent>()

	for (const component of components) {
		for (const type of component.types) {
			// First wins: Google does not return two components of one type in a single result, but if
			// it ever did, taking the first keeps this deterministic.
			if (!index.has(type)) {
				index.set(type, component)
			}
		}
	}

	return index
}

/**
 * The ISO-3166 alpha-2 code for a result, read off its `country` component's `short_name`. `null` when the result has
 * no country component at all, which happens for a bare `plus_code` query.
 */
export function countryCodeOf(result: GoogleGeocodeResult): string | null {
	const country = result.address_components.find((component) => component.types.includes("country"))

	return country?.short_name || null
}

/**
 * Walk {@linkcode COMPONENT_RULES} against one result's components and build the `ComponentTag`-keyed dictionary.
 */
export function buildGoogleComponents(result: GoogleGeocodeResult): ComponentDict {
	const index = indexByType(result.address_components)
	const consumed = new Set<GoogleAddressComponent>()
	const components: ComponentDict = {}
	const countryCode = countryCodeOf(result)
	const abbreviateRegion = countryCode !== null && REGION_ABBREVIATION_COUNTRIES.has(countryCode)

	for (const rule of COMPONENT_RULES) {
		if (components[rule.tag] !== undefined) continue

		for (const type of rule.types) {
			const component = index.get(type)

			if (!component || consumed.has(component)) continue

			const form = rule.tag === "region" && abbreviateRegion ? "short" : rule.form
			const value = form === "short" ? component.short_name : component.long_name

			if (!value) continue

			components[rule.tag] = value
			consumed.add(component)

			break
		}
	}

	// ZIP+4 arrives as a SEPARATE component, and an address written with one writes it hyphenated onto
	// the ZIP (`10001-1234`). Appending is what makes the oracle's `postcode` comparable to a parser
	// output for the same input; leaving the suffix on `raw` alone would make every ZIP+4 case look
	// like a mismatch on the last five characters.
	const postcodeSuffix = index.get("postal_code_suffix")

	if (components.postcode && postcodeSuffix?.long_name) {
		components.postcode = `${components.postcode}-${postcodeSuffix.long_name}`
	}

	return components
}

/**
 * Google's `location_type` → mailwoman's `ResolutionTier`.
 *
 * Three of the four are unambiguous. `GEOMETRIC_CENTER` is not: Google documents it as the centre of "a polyline (for
 * example, a street) or polygon (region)", which spans both the `street` and `admin` tiers depending on which shape it
 * was. The result's own `types` settle it when they name a `route`; otherwise this reports `admin`, which UNDER-claims.
 * That direction is deliberate — an oracle that over-claims precision is worse than one that under-claims, because a
 * case author pinning `expectTier` from it would encode a tolerance the parser can never earn.
 *
 * A missing `location_type` returns `null` rather than a guess. Read `raw.geometry` when it does.
 */
export function toResolutionTier(result: GoogleGeocodeResult): ResolutionTier | null {
	switch (result.geometry.location_type) {
		case GoogleLocationType.Rooftop:
			return "address_point"
		case GoogleLocationType.RangeInterpolated:
			return "interpolated"
		case GoogleLocationType.GeometricCenter:
			return result.types.includes("route") ? "street" : "admin"
		case GoogleLocationType.Approximate:
			return "admin"
		default:
			return null
	}
}

/**
 * The `{ latitude, longitude }` shape the rest of the repo speaks, from Google's `{ lat, lng }`.
 *
 * `GeoPoint` is deliberately NOT in this path. It would validate the pair — which is worth doing on an INPUT, and
 * `google-client.ts` does exactly that on the reverse-geocode argument — but on an OUTPUT it can only discard: a
 * `GeoPoint.from` returning `null` for a coordinate Google actually served would turn a reportable oddity into a
 * missing result. Null Island is the concrete case: `GeoPoint.from` treats `0, 0` as the missing-coordinate sentinel,
 * and a geocode that genuinely lands in the Gulf of Guinea is exactly the kind of thing an oracle should surface rather
 * than swallow.
 */
function toCoordinate(location: GoogleLatLngLiteral): { latitude: number; longitude: number } {
	return { latitude: location.lat, longitude: location.lng }
}

/**
 * Turn one Google `results` entry into the package's normalized {@linkcode OracleGeocodeResult}.
 *
 * `uncertaintyMeters` is left `null` throughout: Google publishes no uncertainty radius, and inventing one per
 * `location_type` would put a fabricated number where the matcher expects a calibrated one.
 */
export function parseGoogleGeocodeResult(result: GoogleGeocodeResult): OracleGeocodeResult<GoogleGeocodeResult> {
	const components = buildGoogleComponents(result)
	const coordinate = toCoordinate(result.geometry.location)

	const geocode: AddressGeocode = {
		coordinate,
		// The tier is required on `AddressGeocode`, and `admin` is the weakest claim available — the
		// right value for "Google did not say". `raw.geometry.location_type` is the ground truth when
		// this matters.
		tier: toResolutionTier(result) ?? "admin",
		uncertaintyMeters: null,
	}

	const address = withGeocode(
		toPostalAddress(components, {
			country: components.country,
			raw: result.formatted_address,
		}),
		geocode
	)

	return {
		provider: OracleProvider.Google,
		address,
		addressID: createPostalAddressID({
			coordinate,
			address: result.formatted_address,
			state: regionPrefix(components.region),
		}),
		// ABSENT means exact — Google only sets this field when it had to loosen the query.
		partialMatch: result.partial_match === true,
		placeID: result.place_id || null,
		plusCode: result.plus_code?.global_code || null,
		raw: result,
	}
}
