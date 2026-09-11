/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for the Google `address_components` → `ComponentTag` mapping.
 *
 *   Fixtures are hand-built from real Geocoding API response shapes; nothing here touches the network.
 *   The cases are chosen to pin the four decisions that are NOT mechanical — the GB `postal_town`
 *   fall-through, the region short/long split, the ZIP+4 join, and the `GEOMETRIC_CENTER` tier
 *   disambiguation — plus the two deliberate divergences from the isp-nexus original (no uppercasing,
 *   no coordinate rounding).
 */

import {
	buildGoogleComponents,
	countryCodeOf,
	parseGoogleGeocodeResult,
	toResolutionTier,
} from "@mailwoman/geocode-oracle/sdk/google-parser"
import type { GoogleAddressComponent, GoogleGeocodeResult } from "@mailwoman/geocode-oracle/sdk/google-types"
import { describe, expect, it } from "vitest"

function component(long: string, short: string, ...types: string[]): GoogleAddressComponent {
	return { long_name: long, short_name: short, types }
}

function result(
	components: GoogleAddressComponent[],
	overrides: Partial<GoogleGeocodeResult> = {}
): GoogleGeocodeResult {
	return {
		address_components: components,
		formatted_address: overrides.formatted_address ?? "somewhere",
		geometry: overrides.geometry ?? { location: { lat: 1, lng: 2 }, location_type: "ROOFTOP" },
		place_id: overrides.place_id ?? "ChIJTestPlaceIdentifier",
		types: overrides.types ?? ["street_address"],
		...overrides,
	}
}

describe("buildGoogleComponents", () => {
	it("maps a US street address onto the ComponentTag vocabulary", () => {
		const components = buildGoogleComponents(
			result([
				component("1600", "1600", "street_number"),
				component("Amphitheatre Parkway", "Amphitheatre Pkwy", "route"),
				component("Mountain View", "Mountain View", "locality", "political"),
				component("Santa Clara County", "Santa Clara County", "administrative_area_level_2", "political"),
				component("California", "CA", "administrative_area_level_1", "political"),
				component("United States", "US", "country", "political"),
				component("94043", "94043", "postal_code"),
			])
		)

		expect(components).toEqual({
			house_number: "1600",
			// `route` takes the LONG name — the abbreviation is Google's display convenience, not the
			// form a parser sees in input.
			street: "Amphitheatre Parkway",
			locality: "Mountain View",
			subregion: "Santa Clara County",
			region: "CA",
			country: "US",
			postcode: "94043",
		})
	})

	it("joins postal_code_suffix onto the postcode as ZIP+4", () => {
		const components = buildGoogleComponents(
			result([
				component("20233", "20233", "postal_code"),
				component("0001", "0001", "postal_code_suffix"),
				component("United States", "US", "country", "political"),
			])
		)

		expect(components.postcode).toBe("20233-0001")
	})

	it("gives the GB post town the locality and pushes the district to dependent_locality", () => {
		const components = buildGoogleComponents(
			result([
				component("Shoreditch", "Shoreditch", "locality", "political"),
				component("London", "London", "postal_town"),
				component("Greater London", "Greater London", "administrative_area_level_2", "political"),
				component("United Kingdom", "GB", "country", "political"),
				component("EC2A 3AY", "EC2A 3AY", "postal_code"),
			])
		)

		expect(components.locality).toBe("London")
		expect(components.dependent_locality).toBe("Shoreditch")
	})

	it("does not write one locality component into two tags", () => {
		// The consume-once rule. Without it the trailing `locality → dependent_locality` fall-through
		// would duplicate the value into both tags for every non-GB address on earth.
		const components = buildGoogleComponents(
			result([component("Paris", "Paris", "locality", "political"), component("France", "FR", "country", "political")])
		)

		expect(components.locality).toBe("Paris")
		expect(components.dependent_locality).toBeUndefined()
	})

	it("takes the long region form outside the abbreviating countries", () => {
		const components = buildGoogleComponents(
			result([
				component("Île-de-France", "IDF", "administrative_area_level_1", "political"),
				component("France", "FR", "country", "political"),
			])
		)

		expect(components.region).toBe("Île-de-France")
	})

	it("takes the short region form inside them", () => {
		const components = buildGoogleComponents(
			result([
				component("New South Wales", "NSW", "administrative_area_level_1", "political"),
				component("Australia", "AU", "country", "political"),
			])
		)

		expect(components.region).toBe("NSW")
	})

	it("preserves diacritics and case rather than uppercasing", () => {
		// The isp-nexus original ended both accessors in `.toUpperCase()`. This is the assertion that
		// stops that coming back.
		const components = buildGoogleComponents(
			result([
				component("Köln", "Köln", "locality", "political"),
				component("Nordrhein-Westfalen", "NW", "administrative_area_level_1", "political"),
				component("Germany", "DE", "country", "political"),
			])
		)

		expect(components.locality).toBe("Köln")
		expect(components.region).toBe("Nordrhein-Westfalen")
	})

	it("takes the first present unit slot", () => {
		const components = buildGoogleComponents(
			result([component("Apt 4B", "Apt 4B", "subpremise"), component("3", "3", "floor")])
		)

		expect(components.unit).toBe("Apt 4B")
	})
})

describe("countryCodeOf", () => {
	it("reads the ISO-2 code off the country component", () => {
		expect(countryCodeOf(result([component("Japan", "JP", "country", "political")]))).toBe("JP")
	})

	it("returns null when there is no country component", () => {
		expect(countryCodeOf(result([component("94043", "94043", "postal_code")]))).toBeNull()
	})
})

describe("toResolutionTier", () => {
	it.each([
		["ROOFTOP", "address_point"],
		["RANGE_INTERPOLATED", "interpolated"],
		["APPROXIMATE", "admin"],
	])("maps %s to %s", (locationType, tier) => {
		expect(
			toResolutionTier(result([], { geometry: { location: { lat: 1, lng: 2 }, location_type: locationType } }))
		).toBe(tier)
	})

	it("maps GEOMETRIC_CENTER on a route to the street tier", () => {
		expect(
			toResolutionTier(
				result([], {
					geometry: { location: { lat: 1, lng: 2 }, location_type: "GEOMETRIC_CENTER" },
					types: ["route"],
				})
			)
		).toBe("street")
	})

	it("under-claims GEOMETRIC_CENTER on anything else", () => {
		expect(
			toResolutionTier(
				result([], {
					geometry: { location: { lat: 1, lng: 2 }, location_type: "GEOMETRIC_CENTER" },
					types: ["administrative_area_level_2", "political"],
				})
			)
		).toBe("admin")
	})

	it("returns null rather than guessing when location_type is absent", () => {
		expect(toResolutionTier(result([], { geometry: { location: { lat: 1, lng: 2 } } }))).toBeNull()
	})
})

describe("parseGoogleGeocodeResult", () => {
	const paris = result(
		[
			component("181", "181", "street_number"),
			component("Rue du Chevaleret", "Rue du Chevaleret", "route"),
			component("Paris", "Paris", "locality", "political"),
			component("Île-de-France", "IDF", "administrative_area_level_1", "political"),
			component("France", "FR", "country", "political"),
			component("75013", "75013", "postal_code"),
		],
		{
			formatted_address: "181 Rue du Chevaleret, 75013 Paris, France",
			geometry: { location: { lat: 48.8335023, lng: 2.3686051 }, location_type: "ROOFTOP" },
			place_id: "ChIJ_____ChevaleretPlace",
			plus_code: { global_code: "8FW4V75V+8Q" },
			types: ["street_address"],
		}
	)

	it("produces a record carrying the coordinate, the tier and the provenance", () => {
		const parsed = parseGoogleGeocodeResult(paris)

		expect(parsed.provider).toBe("google")
		// Untouched — the original rounded both axes through `toPrecision(9)`.
		expect(parsed.address.geocode?.coordinate).toEqual({ latitude: 48.8335023, longitude: 2.3686051 })
		expect(parsed.address.geocode?.tier).toBe("address_point")
		expect(parsed.address.geocode?.uncertaintyMeters).toBeNull()
		expect(parsed.address.raw).toBe("181 Rue du Chevaleret, 75013 Paris, France")
		expect(parsed.address.canonicalKey).toContain("75013")
		expect(parsed.placeID).toBe("ChIJ_____ChevaleretPlace")
		expect(parsed.plusCode).toBe("8FW4V75V+8Q")
		expect(parsed.raw).toBe(paris)
	})

	it("treats an absent partial_match as exact", () => {
		expect(parseGoogleGeocodeResult(paris).partialMatch).toBe(false)
		expect(parseGoogleGeocodeResult({ ...paris, partial_match: true }).partialMatch).toBe(true)
	})

	it("mints an address ID that its own parser can read back", () => {
		// The guard on the `state` prefix: `Île-de-France` is not a two-letter code, so it must NOT be
		// interpolated into the key. Without the guard this ID is `île-de-france.<cell>.<hash>` and
		// `isPostalAddressID` rejects it.
		expect(parseGoogleGeocodeResult(paris).addressID).toMatch(/^[a-z]{2}\.[0-9a-f]+\.[0-9a-f]{16}$/)
	})

	it("uses a two-letter region as the address-ID prefix when there is one", () => {
		const parsed = parseGoogleGeocodeResult(
			result(
				[
					component("California", "CA", "administrative_area_level_1", "political"),
					component("United States", "US", "country", "political"),
				],
				{ formatted_address: "Somewhere, CA, USA", geometry: { location: { lat: 37, lng: -122 } } }
			)
		)

		expect(parsed.addressID.startsWith("ca.")).toBe(true)
	})
})
