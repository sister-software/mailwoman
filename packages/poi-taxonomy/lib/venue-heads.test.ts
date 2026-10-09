/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { venueHeadCountries, venueHeadLexicon, venueHeadProvenance } from "#venue-heads"

describe("venueHeadLexicon", () => {
	it("answers a last-word head for an English-speaking country", () => {
		expect(venueHeadLexicon("GB").last("gallery")).toBeGreaterThan(0)
	})

	it("answers a first-word head for a French-speaking country", () => {
		expect(venueHeadLexicon("FR").first("musée")).toBeGreaterThan(0)
	})

	it("reads the country code case-insensitively", () => {
		expect(venueHeadLexicon("gb").last("gallery")).toBe(venueHeadLexicon("GB").last("gallery"))
	})

	it("answers a Han suffix in a session of any locale", () => {
		expect(venueHeadLexicon("US").suffix("国立西洋美術館")).not.toBeNull()
	})

	it("returns null for a Latin word in a country with no entries and no language aggregate", () => {
		expect(venueHeadLexicon("ZZ").last("gallery")).toBeNull()
	})

	it("returns null for a street type", () => {
		expect(venueHeadLexicon("GB").last("road")).toBeNull()
		expect(venueHeadLexicon("FR").first("rue")).toBeNull()
	})
})

describe("the packaged table", () => {
	it("names its three sources and the bars it was built with", () => {
		const provenance = venueHeadProvenance()

		expect(provenance.venueSource).toMatch(/overture/)
		expect(provenance.minSupport).toBeGreaterThan(0)
	})

	it("holds entries for countries on more than one continent", () => {
		const countries = new Set(venueHeadCountries())

		for (const country of ["GB", "US", "FR", "DE", "JP", "BR"]) {
			expect(countries.has(country)).toBe(true)
		}
	})
})
