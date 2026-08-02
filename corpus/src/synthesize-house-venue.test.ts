/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { makeLcg } from "@mailwoman/core/utils"
import { describe, expect, it } from "vitest"

import { type HouseVenueBaseTuple, hasHouseNumberAndVenue, synthesizeHouseVenueRow } from "./synthesize-house-venue.ts"

const TUPLE: HouseVenueBaseTuple = {
	locality: "Boston",
	region: "MA",
	postcode: "02101",
	country: "US",
}

describe("synthesizeHouseVenueRow", () => {
	it("emits venue-after-street form", () => {
		const row = synthesizeHouseVenueRow(TUPLE, {
			random: makeLcg(1),
			forceTemplate: "venue-after-street",
		})

		expect(row).not.toBeNull()
		expect(row!.template).toBe("venue-after-street")
		expect(row!.raw).toMatch(/^\d+ .+, .+, Boston, MA 02101(, (United States|USA))?$/)
		expect(hasHouseNumberAndVenue(row!.components)).toBe(true)
	})

	it("emits venue-before-street form", () => {
		const row = synthesizeHouseVenueRow(TUPLE, {
			random: makeLcg(2),
			forceTemplate: "venue-before-street",
		})

		expect(row).not.toBeNull()
		expect(row!.template).toBe("venue-before-street")
		expect(row!.raw).toMatch(/^.+, \d+ .+, Boston, MA 02101$/)
		expect(hasHouseNumberAndVenue(row!.components)).toBe(true)
	})

	it("uses base tuple's street + houseNumber when present", () => {
		const row = synthesizeHouseVenueRow(
			{ ...TUPLE, street: "Newbury St", houseNumber: "234" },
			{ random: makeLcg(3), forceTemplate: "venue-after-street" }
		)

		expect(row).not.toBeNull()
		expect(row!.components.street).toBe("Newbury St")
		expect(row!.components.house_number).toBe("234")
		expect(row!.raw).toMatch(/^234 Newbury St/)
	})

	it("falls back to internal pool when tuple lacks street + houseNumber", () => {
		const row = synthesizeHouseVenueRow(TUPLE, { random: makeLcg(4) })
		expect(row).not.toBeNull()
		expect(row!.components.street).toBeDefined()
		expect(row!.components.house_number).toBeDefined()
		expect(row!.components.house_number!).toMatch(/^\d+$/)
	})

	it("FR renders postcode-before-locality with NO region (the run-2 contingency shape)", () => {
		const frTuple: HouseVenueBaseTuple = {
			locality: "Paris",
			region: "Île-de-France",
			postcode: "75005",
			country: "FR",
			street: "Rue de la Huchette",
			houseNumber: "20",
		}

		const row = synthesizeHouseVenueRow(frTuple, {
			random: makeLcg(3),
			forceTemplate: "venue-before-street",
		})

		expect(row).not.toBeNull()
		// The exact gauntlet failure family: "VENUE, 20 Rue de la Huchette, 75005 Paris".
		expect(row!.raw).toMatch(/^.+, 20 Rue de la Huchette, 75005 Paris$/)
		expect(row!.components.region).toBeUndefined()
		expect(row!.components.postcode).toBe("75005")
		expect(hasHouseNumberAndVenue(row!.components)).toBe(true)
	})

	it("GB renders locality-then-postcode with NO region and NO comma between them (#1366)", () => {
		const gbTuple: HouseVenueBaseTuple = {
			locality: "London",
			region: "Greater London",
			postcode: "EC3N 1DE",
			country: "GB",
			street: "Minories",
			houseNumber: "27",
		}

		const row = synthesizeHouseVenueRow(gbTuple, {
			random: makeLcg(5),
			forceTemplate: "venue-before-street",
		})

		expect(row).not.toBeNull()
		// The #1366 gauntlet failure family: "VENUE, 27 Minories, London EC3N 1DE".
		expect(row!.raw).toMatch(/^.+, 27 Minories, London EC3N 1DE$/)
		expect(row!.components.region).toBeUndefined()
		expect(row!.components.postcode).toBe("EC3N 1DE")
		expect(row!.components.locality).toBe("London")
		expect(row!.locale).toBe("en-GB")
		expect(hasHouseNumberAndVenue(row!.components)).toBe(true)
	})

	it("GB venue-after-street keeps the GB tail", () => {
		const row = synthesizeHouseVenueRow(
			{
				locality: "Manchester",
				region: "Greater Manchester",
				postcode: "M1 1AE",
				country: "GB",
				street: "Portland Street",
				houseNumber: "101",
			},
			{ random: makeLcg(6), forceTemplate: "venue-after-street" }
		)

		expect(row).not.toBeNull()
		expect(row!.raw).toMatch(/^101 Portland Street, .+, Manchester M1 1AE$/)
	})

	it("GB emits range house numbers at the pre-registered rate (~15% across 2000 rows)", () => {
		const random = makeLcg(7)
		let ranges = 0

		for (let i = 0; i < 2000; i++) {
			const row = synthesizeHouseVenueRow(
				{ locality: "London", region: "Greater London", postcode: "N1 7AA", country: "GB" },
				{ random }
			)

			if (/^\d+-\d+$/.test(row!.components.house_number!)) {
				ranges++

				// The raw must open with (venue-before) or contain the full range span.
				expect(row!.raw).toContain(row!.components.house_number!)
			}
		}

		expect(ranges / 2000).toBeGreaterThan(0.08)
		expect(ranges / 2000).toBeLessThan(0.25)
	})

	it("appends a tagged country surface at the pre-registered rate, in every order (Addendum 3)", () => {
		const random = makeLcg(9)
		let appended = 0

		for (let i = 0; i < 2000; i++) {
			const row = synthesizeHouseVenueRow(
				i % 2 === 0
					? { locality: "London", region: "Greater London", postcode: "E2 8AX", country: "GB" }
					: { locality: "Paris", region: "", postcode: "75004", country: "FR" },
				{ random }
			)

			if (row!.components.country) {
				appended++
				// The raw ends with the tagged surface, comma-joined after the tail.
				expect(row!.raw.endsWith(`, ${row!.components.country}`)).toBe(true)
			}
		}

		expect(appended / 2000).toBeGreaterThan(0.22)
		expect(appended / 2000).toBeLessThan(0.38)
	})

	it("country-tailed GB rows keep the locality-postcode tail ahead of the country", () => {
		for (let seed = 0; seed < 200; seed++) {
			const row = synthesizeHouseVenueRow(
				{
					locality: "London",
					region: "Greater London",
					postcode: "EC3N 1DE",
					country: "GB",
					street: "Minories",
					houseNumber: "27",
				},
				{ random: makeLcg(seed), forceTemplate: "venue-before-street" }
			)

			if (row!.components.country) {
				expect(row!.raw).toMatch(/, 27 Minories, London EC3N 1DE, (United Kingdom|UK)$/)

				return
			}
		}

		throw new Error("no country-tailed GB row in 200 seeds")
	})

	it("GB never emits the held-out #1366 gauntlet venue names", () => {
		const random = makeLcg(8)

		const heldOut = [
			"Ye Three Lords",
			"Southfields Station",
			"New North Health Centre",
			"The North Face - Covent Garden",
			"Far East Chinese 口福羊汤",
			"East India Club",
		]

		for (let i = 0; i < 2000; i++) {
			const row = synthesizeHouseVenueRow(
				{ locality: "London", region: "Greater London", postcode: "SW1Y 4LH", country: "GB" },
				{ random }
			)

			for (const name of heldOut) {
				expect(row!.components.venue).not.toBe(name)
			}
		}
	})

	it("FR venue-after-street keeps the FR tail", () => {
		const row = synthesizeHouseVenueRow(
			{
				locality: "Lyon",
				region: "",
				postcode: "69001",
				country: "FR",
				street: "Rue de la République",
				houseNumber: "5",
			},
			{ random: makeLcg(4), forceTemplate: "venue-after-street" }
		)

		expect(row).not.toBeNull()
		expect(row!.raw).toMatch(/^5 Rue de la République, .+, 69001 Lyon$/)
	})

	it("ALWAYS emits both house_number AND venue across 500 random invocations", () => {
		const rng = makeLcg(42)

		for (let i = 0; i < 500; i++) {
			const row = synthesizeHouseVenueRow(TUPLE, { random: rng })
			expect(row).not.toBeNull()
			expect(hasHouseNumberAndVenue(row!.components)).toBe(true)
			// Also require street + locality + region + postcode
			expect(row!.components.street).toBeDefined()
			expect(row!.components.locality).toBe("Boston")
			expect(row!.components.region).toBe("MA")
			expect(row!.components.postcode).toBe("02101")
		}
	})

	it("template distribution is balanced across 1000 invocations", () => {
		const rng = makeLcg(99)
		const counts = { "venue-after-street": 0, "venue-before-street": 0 }

		for (let i = 0; i < 1000; i++) {
			const row = synthesizeHouseVenueRow(TUPLE, { random: rng })

			counts[row!.template]++
		}

		// 50/50 split with reasonable tolerance
		expect(counts["venue-after-street"]).toBeGreaterThan(400)
		expect(counts["venue-after-street"]).toBeLessThan(600)
		expect(counts["venue-before-street"]).toBeGreaterThan(400)
		expect(counts["venue-before-street"]).toBeLessThan(600)
	})

	it("respects per-country locale", () => {
		for (const [country, expectedLocale] of [
			["US", "en-US"],
			["FR", "fr-FR"],
			["DE", "de-DE"],
			["GB", "en-GB"],
		] as const) {
			const row = synthesizeHouseVenueRow(
				{ ...TUPLE, country },
				{ random: makeLcg(7), forceTemplate: "venue-after-street" }
			)

			expect(row!.locale).toBe(expectedLocale)
		}
	})
})
