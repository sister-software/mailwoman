/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import {
	type AnnotationSet,
	type Annotator,
	composeAnnotators,
	composeStreetAddress,
	toNative,
	toOpenCage,
	toSchemaOrg,
} from "./index.ts"

test("composeAnnotators: merges partial results from multiple annotators", async () => {
	const coords: Annotator = () => ({ geohash: "dqcjqcp84", mgrs: "18SUJ23480647" })
	const country: Annotator = () => ({ callingCode: 1, currency: { isoCode: "USD" } })
	const set = await composeAnnotators([coords, country])({ lat: 38.8977, lon: -77.0365 })

	expect(set.geohash).toBe("dqcjqcp84")
	expect(set.mgrs).toBe("18SUJ23480647")
	expect(set.callingCode).toBe(1)
	expect(set.currency).toEqual({ isoCode: "USD" })
})

test("composeAnnotators: a throwing annotator is skipped, the rest still apply", async () => {
	const ok: Annotator = () => ({ flag: "🇺🇸" })
	const boom: Annotator = () => {
		throw new Error("nope")
	}
	const set = await composeAnnotators([boom, ok])({ lat: 0, lon: 0 })

	expect(set.flag).toBe("🇺🇸")
})

test("composeAnnotators: later annotators win on key collision", async () => {
	const a: Annotator = () => ({ timezone: { name: "UTC" } })
	const b: Annotator = () => ({ timezone: { name: "America/New_York", offsetSec: -18000 } })
	const set = await composeAnnotators([a, b])({ lat: 0, lon: 0 })

	expect(set.timezone).toEqual({ name: "America/New_York", offsetSec: -18000 })
})

test("toOpenCage: maps native fields to OpenCage key names + casing", () => {
	const set: AnnotationSet = {
		dms: { lat: "38° 53′ 51″ N", lon: "77° 02′ 11″ W" },
		geohash: "dqcjqcp84",
		mercator: { x: -8575528, y: 4707174 },
		qiblaBearing: 58.4,
		callingCode: 1,
		currency: { isoCode: "USD", symbol: "$" },
		flag: "🇺🇸",
		timezone: { name: "America/New_York", offsetSec: -18000 },
		fips: "11001",
	}
	const oc = toOpenCage(set)

	expect(oc.DMS).toEqual({ lat: "38° 53′ 51″ N", lng: "77° 02′ 11″ W" }) // lon -> lng
	expect(oc.geohash).toBe("dqcjqcp84")
	expect(oc.Mercator).toEqual({ x: -8575528, y: 4707174 })
	expect(oc.qibla).toBe(58.4)
	expect(oc.callingcode).toBe(1)
	expect(oc.currency).toEqual({ iso_code: "USD", symbol: "$" }) // isoCode -> iso_code
	expect(oc.flag).toBe("🇺🇸")
	expect(oc.timezone).toEqual({ name: "America/New_York", offset_sec: -18000 }) // offsetSec -> offset_sec
	expect(oc.FIPS).toEqual({ county: "11001" })
})

test("toOpenCage: omits unpopulated fields", () => {
	expect(toOpenCage({})).toEqual({})
	expect(toOpenCage({ geohash: "x" })).toEqual({ geohash: "x" })
})

test("toNative: returns the native set unchanged", () => {
	const set: AnnotationSet = { geohash: "x", callingCode: 44 }
	expect(toNative(set)).toEqual(set)
})

// schema.org Place / PostalAddress / GeoCoordinates JSON-LD projection (#1052)

test("composeStreetAddress: collapses housenumber + street + unit into one number-first line", () => {
	expect(composeStreetAddress({ houseNumber: "8", street: "Boulevard du Palais" })).toBe("8 Boulevard du Palais")
	// The lossy collapse: unit rides the same opaque string (schema.org has no unit slot).
	expect(composeStreetAddress({ houseNumber: "350", street: "5th Ave", unit: "Apt 4B" })).toBe("350 5th Ave Apt 4B")
	// Blank parts drop out; an all-empty input is "".
	expect(composeStreetAddress({ street: "5th Ave" })).toBe("5th Ave")
	expect(composeStreetAddress({ houseNumber: "  ", street: "" })).toBe("")
})

test("toSchemaOrg: full Place with geo + PostalAddress, ISO-3166 alpha-2 country (uppercased)", () => {
	const place = toSchemaOrg({
		lat: 48.8556,
		lon: 2.3448,
		streetAddress: "8 Boulevard du Palais",
		locality: "Paris",
		region: "Île-de-France",
		postalCode: "75001",
		countryCode: "fr", // lowercase in → uppercase out
	})

	expect(place["@context"]).toBe("https://schema.org")
	expect(place["@type"]).toBe("Place")
	expect(place.geo).toEqual({ "@type": "GeoCoordinates", latitude: 48.8556, longitude: 2.3448 })
	expect(place.address).toEqual({
		"@type": "PostalAddress",
		streetAddress: "8 Boulevard du Palais",
		addressLocality: "Paris",
		addressRegion: "Île-de-France",
		postalCode: "75001",
		addressCountry: "FR",
	})
})

test("toSchemaOrg: omits absent fields entirely (never null)", () => {
	const place = toSchemaOrg({ lat: 40.0, lon: -75.0, locality: "Philadelphia", countryCode: "US" })

	expect(place.name).toBeUndefined()
	expect(place.address?.streetAddress).toBeUndefined()
	expect(place.address?.postalCode).toBeUndefined()
	expect(place.address?.addressRegion).toBeUndefined()
	// No null-valued keys anywhere in the JSON.
	expect(JSON.stringify(place)).not.toContain("null")
	expect(place.address).toEqual({ "@type": "PostalAddress", addressLocality: "Philadelphia", addressCountry: "US" })
})

test("toSchemaOrg: geo omitted when the coordinate is missing / non-finite", () => {
	expect(toSchemaOrg({ lat: null, lon: null, locality: "Nowhere" }).geo).toBeUndefined()
	expect(toSchemaOrg({ lat: Number.NaN, lon: 2, locality: "Nowhere" }).geo).toBeUndefined()
	// An address with no fields at all yields a bare Place (no `address` key).
	expect(toSchemaOrg({ lat: 1, lon: 2 }).address).toBeUndefined()
})

test("toSchemaOrg: PO box maps to postOfficeBoxNumber; name carries a venue", () => {
	const place = toSchemaOrg({ lat: 38.9, lon: -77.0, name: "The White House", poBox: "12345", countryCode: "us" })

	expect(place.name).toBe("The White House")
	expect(place.address?.postOfficeBoxNumber).toBe("12345")
	expect(place.address?.streetAddress).toBeUndefined()
	expect(place.address?.addressCountry).toBe("US")
})
