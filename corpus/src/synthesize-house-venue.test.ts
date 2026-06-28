/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { type HouseVenueBaseTuple, hasHouseNumberAndVenue, synthesizeHouseVenueRow } from "./synthesize-house-venue.js"

function seededRandom(seed: number): () => number {
	let s = seed

	return () => {
		s = (s * 1664525 + 1013904223) % 4294967296

		return s / 4294967296
	}
}

const TUPLE: HouseVenueBaseTuple = {
	locality: "Boston",
	region: "MA",
	postcode: "02101",
	country: "US",
}

describe("synthesizeHouseVenueRow", () => {
	it("emits venue-after-street form", () => {
		const row = synthesizeHouseVenueRow(TUPLE, {
			random: seededRandom(1),
			forceTemplate: "venue-after-street",
		})
		expect(row).not.toBeNull()
		expect(row!.template).toBe("venue-after-street")
		expect(row!.raw).toMatch(/^\d+ .+, .+, Boston, MA 02101$/)
		expect(hasHouseNumberAndVenue(row!.components)).toBe(true)
	})

	it("emits venue-before-street form", () => {
		const row = synthesizeHouseVenueRow(TUPLE, {
			random: seededRandom(2),
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
			{ random: seededRandom(3), forceTemplate: "venue-after-street" }
		)
		expect(row).not.toBeNull()
		expect(row!.components.street).toBe("Newbury St")
		expect(row!.components.house_number).toBe("234")
		expect(row!.raw).toMatch(/^234 Newbury St/)
	})

	it("falls back to internal pool when tuple lacks street + houseNumber", () => {
		const row = synthesizeHouseVenueRow(TUPLE, { random: seededRandom(4) })
		expect(row).not.toBeNull()
		expect(row!.components.street).toBeDefined()
		expect(row!.components.house_number).toBeDefined()
		expect(row!.components.house_number!).toMatch(/^\d+$/)
	})

	it("ALWAYS emits both house_number AND venue across 500 random invocations", () => {
		const rng = seededRandom(42)

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
		const rng = seededRandom(99)
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
				{ random: seededRandom(7), forceTemplate: "venue-after-street" }
			)
			expect(row!.locale).toBe(expectedLocale)
		}
	})
})
