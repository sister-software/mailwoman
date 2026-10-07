/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Google Geocoding result → mailwoman {@linkcode OracleGeocodeResult}.
 *
 *   The casing matches Google's response because this oracle canonicalizes gauntlet cases across about 160
 *   countries. Uppercase conversion would turn `Köln` into `KÖLN` and alter CJK and Cyrillic names as well.
 *
 *   The component mapping is a judgment call. {@linkcode OracleGeocodeResult.raw} preserves the full
 *   response when that mapping loses information. See {@linkcode COMPONENT_RULES} for the ordering rule and
 *   {@linkcode REGION_ABBREVIATION_COUNTRIES} for the one place a country-conditional choice is made.
 */

import { createPostalAddressID } from "@mailwoman/address-id"
import type { ResolutionTier } from "@mailwoman/annotations/geo"
import type { ComponentDict } from "@mailwoman/codex/address/format"
import { type AddressGeocode, toPostalAddress, withGeocode } from "@mailwoman/record"

import { OracleProvider, type OracleGeocodeResult, regionPrefix } from "#result"
import {
	type GoogleAddressComponent,
	type GoogleGeocodeResult,
	GoogleLocationType,
	type GoogleLatLngLiteral,
} from "#sdk/google/types"

type NameForm = "long" | "short"

interface ComponentRule {
	types: string[]
	tag: keyof ComponentDict
	form: NameForm
}

/**
 * The component-type → `ComponentTag` table, IN priority order.
 *
 * The walk applies two first-writer-wins rules.
 * It writes each tag once and consumes each component once.
 *
 * Rule 2 is what makes the two `locality` entries correct rather than a duplication bug:
 * Google returns a GB address as `postal_town: "London"` and may also return a
 * `locality` holding the district, so `postal_town` takes `locality` and the district
 * falls through to `dependent_locality`; with no `postal_town` the first `locality`
 * rule consumes the component and the second finds none left.
 *
 * `raw` retains component types this mapping leaves unused: `political`, `administrative_area_level_3`
 * and lower levels (a comune in Italy, a ward in Japan, a census-designated area in the United States),
 * `postal_code_prefix`, and each `plus_code`-derived pseudo-component.
 */
const COMPONENT_RULES: readonly ComponentRule[] = [
	{ types: ["street_number"], tag: "house_number", form: "short" },
	{ types: ["route"], tag: "street", form: "long" },
	// Google splits a unit designator across three types.
	// Any of them is the unit line, first present wins.
	{ types: ["subpremise"], tag: "unit", form: "short" },
	{ types: ["room"], tag: "unit", form: "short" },
	{ types: ["floor"], tag: "unit", form: "short" },
	{ types: ["post_box"], tag: "po_box", form: "short" },
	// A building or business with a name: `premise` is the building, the POI types are what "Eiffel Tower" comes back as.
	{ types: ["premise"], tag: "venue", form: "long" },
	{ types: ["point_of_interest", "establishment"], tag: "venue", form: "long" },
	{ types: ["postal_code"], tag: "postcode", form: "long" },
	{ types: ["postal_town"], tag: "locality", form: "long" },
	{ types: ["locality"], tag: "locality", form: "long" },
	{ types: ["sublocality", "sublocality_level_1"], tag: "dependent_locality", form: "long" },
	{ types: ["neighborhood"], tag: "dependent_locality", form: "long" },
	{ types: ["locality"], tag: "dependent_locality", form: "long" },
	{ types: ["administrative_area_level_2"], tag: "subregion", form: "long" },
	// `region` takes its form from the country — see REGION_ABBREVIATION_COUNTRIES —
	// with this `form` as the fallback for an unknown country.
	{ types: ["administrative_area_level_1"], tag: "region", form: "long" },
	{ types: ["country"], tag: "country", form: "short" },
]

/**
 * The countries whose written postal convention puts the first-level subdivision in its abbreviated form,
 * so `administrative_area_level_1` is taken from `short_name` there and `long_name` everywhere else.
 *
 * The list is short on purpose: `NY`, `on`, `NSW`, `JAL` and `SP` are what appears on the envelope,
 * while a French address writes `Île-de-France` and a German one `Nordrhein-Westfalen`.
 *
 * When this is wrong FOR your case, read `raw.address_components`.
 * Both forms are always there.
 *
 * This is a default that makes the common case right rather than a claim about postal law.
 */
const REGION_ABBREVIATION_COUNTRIES = new Set(["US", "CA", "AU", "MX", "BR"])

/**
 * Index every component by every type it has, so a lookup is a map probe rather than an array scan
 * and a component tagged both `locality` and `political` is the same object under both keys.
 */
function indexByType(components: readonly GoogleAddressComponent[]): Map<string, GoogleAddressComponent> {
	const index = new Map<string, GoogleAddressComponent>()

	for (const component of components) {
		for (const type of component.types) {
			// Google does not return two components of one type, but if it did, first wins keeps this deterministic.
			if (!index.has(type)) {
				index.set(type, component)
			}
		}
	}

	return index
}

/**
 * The ISO-3166 alpha-2 code for a result, read off its `country` component's `short_name`.
 *
 * Returns `null` when the result has no country component.
 * This occurs for a bare `plus_code` query.
 */
export function countryCodeOf(result: GoogleGeocodeResult): string | null {
	const country = result.address_components.find((component) => component.types.includes("country"))

	return country?.short_name || null
}

/**
 * Walk {@linkcode COMPONENT_RULES} against one result's components and build
 * the `ComponentTag`-keyed dictionary.
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

	// ZIP+4 arrives as a separate component and is written hyphenated onto the ZIP (`10001-1234`),
	// so appending it is what keeps the oracle's `postcode` comparable to a parser output.
	const postcodeSuffix = index.get("postal_code_suffix")

	if (components.postcode && postcodeSuffix?.long_name) {
		components.postcode = `${components.postcode}-${postcodeSuffix.long_name}`
	}

	return components
}

/**
 * Google's `location_type` → mailwoman's `ResolutionTier`.
 *
 * `GEOMETRIC_CENTER` is ambiguous — the center of "a polyline (for example, a street)
 * or polygon (region)" spans both `street` and `admin` — so a `route` in the result's
 * own `types` identifies a street and everything else reports `admin`.
 *
 * Under-claiming is deliberate: an oracle that over-claims precision would have a case
 * author pin an `expectTier` tolerance the parser can never earn.
 *
 * A missing `location_type` returns `null` rather than a guess.
 * Read `raw.geometry` when it does.
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
 * Converts Google's `{ lat, lng }` result to the repo's `{ latitude, longitude }` shape.
 *
 * `GeoPoint` treats `0, 0` as the missing-coordinate sentinel.
 * This conversion preserves a geocode at `0, 0`, including a result in the Gulf of Guinea.
 */
function toCoordinate(location: GoogleLatLngLiteral): { latitude: number; longitude: number } {
	return { latitude: location.lat, longitude: location.lng }
}

/**
 * Turn one Google `results` entry into the package's normalized {@linkcode OracleGeocodeResult}.
 *
 * `uncertaintyMeters` is `null` because Google publishes no uncertainty radius.
 * A value derived from `location_type` would put a fabricated number
 * where the matcher expects a calibrated value.
 */
export function parseGoogleGeocodeResult(result: GoogleGeocodeResult): OracleGeocodeResult<GoogleGeocodeResult> {
	const components = buildGoogleComponents(result)
	const coordinate = toCoordinate(result.geometry.location)

	const geocode: AddressGeocode = {
		coordinate,
		// `admin` is the weakest claim available for "Google did not say";
		// `raw.geometry.location_type` is the ground truth when this matters.
		tier: toResolutionTier(result) ?? "admin",
		uncertaintyMeters: null,
		hierarchy: null,
		poBox: null,
		multiUnit: null,
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
			state: regionPrefix(components.region) ?? undefined,
		}),
		// Absent means exact — Google only sets this field when it had to loosen the query.
		partialMatch: result.partial_match === true,
		placeID: result.place_id || null,
		plusCode: result.plus_code?.global_code || null,
		raw: result,
	}
}
