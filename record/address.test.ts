/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { type AddressGeocode, type PostalAddress, toPostalAddress, withGeocode } from "./address.js"

const US: PostalAddress["components"] = {
	house_number: "123",
	street: "Main",
	street_suffix: "St",
	locality: "Portland",
	region: "OR",
	postcode: "97201",
	country: "US",
}

describe("toPostalAddress", () => {
	it("fills the canonical match key and a single-line formatted form", () => {
		const record = toPostalAddress(US)

		expect(record.canonicalKey).toBe("123|main|st|portland|or|97201|us")
		expect(record.components).toBe(US)
		expect(record.formatted).toBeTruthy()
		expect(record.formatted).not.toContain("\n")
		expect(record.formatted).toContain("Portland")
	})

	it("derives the country from the component when not given explicitly", () => {
		const record = toPostalAddress({ locality: "Paris", postcode: "75008", country: "FR" })
		expect(record.canonicalKey).toContain("paris")
		expect(record.formatted).toContain("Paris")
	})

	it("skips the formatted form when format is false", () => {
		const record = toPostalAddress(US, { format: false })
		expect(record.formatted).toBeUndefined()
		expect(record.canonicalKey).toBeTruthy()
	})

	it("retains the raw input as provenance when provided", () => {
		const record = toPostalAddress(US, { raw: "123 Main St, Portland OR 97201" })
		expect(record.raw).toBe("123 Main St, Portland OR 97201")
	})

	it("starts with no geocode", () => {
		expect(toPostalAddress(US).geocode).toBeUndefined()
	})
})

describe("withGeocode", () => {
	const geocode: AddressGeocode = {
		coordinate: { latitude: 45.5152, longitude: -122.6784 },
		tier: "address_point",
		uncertaintyMeters: 1,
		hierarchy: [
			{ tag: "locality", value: "Portland", placeId: "101715829" },
			{ tag: "region", value: "Oregon", placeId: "85688513" },
		],
	}

	it("attaches a resolved geocode without mutating the original record", () => {
		const base = toPostalAddress(US)
		const located = withGeocode(base, geocode)

		expect(base.geocode).toBeUndefined()
		expect(located.geocode).toBe(geocode)
		expect(located.geocode?.tier).toBe("address_point")
		expect(located.canonicalKey).toBe(base.canonicalKey)
	})

	it("carries the weakening flags through (PO box / multi-unit)", () => {
		const located = withGeocode(toPostalAddress(US), {
			coordinate: { latitude: 45.5, longitude: -122.6 },
			tier: "interpolated",
			uncertaintyMeters: 120,
			poBox: true,
		})

		expect(located.geocode?.poBox).toBe(true)
		expect(located.geocode?.uncertaintyMeters).toBe(120)
	})
})
