/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { synthesizeStreetRow } from "./synthesize-street.js"

function seededRandom(seed: number): () => number {
	let s = seed

	return () => {
		s = (s * 1664525 + 1013904223) % 4294967296

		return s / 4294967296
	}
}

describe("synthesizeStreetRow", () => {
	it("emits all required components", () => {
		const row = synthesizeStreetRow(
			{ locality: "Burlington", region: "VT", postcode: "05401", country: "US" },
			{ random: seededRandom(1) }
		)
		expect(row).not.toBeNull()
		expect(row!.locale).toBe("en-US")
		expect(row!.components.locality).toBe("Burlington")
		expect(row!.components.region).toBe("VT")
		expect(row!.components.postcode).toBe("05401")
		// `country` is intentionally omitted from `components` — see the note in
		// `synthesize-street.ts` about the aligner's edit-distance-2 fuzzy match spuriously
		// pairing "US" with arbitrary 2-char tokens (e.g. a house number "45"). The base country
		// is consumed only to gate the synthesizer (US-only) and to select the locale tag.
		expect(row!.components.country).toBeUndefined()
		// At minimum a street name must be present
		expect(row!.components.street).toBeDefined()
	})

	it("emits Stage 3 decomposed components when applicable", () => {
		// Generate many variants and check that at least some get decomposed
		let hasPrefix = 0
		let hasSuffix = 0
		const rng = seededRandom(42)

		for (let i = 0; i < 50; i++) {
			const r = synthesizeStreetRow(
				{ locality: "Boston", region: "MA", postcode: "02101", country: "US" },
				{ random: rng }
			)

			if (r!.components.street_prefix) {
				hasPrefix++
			}

			if (r!.components.street_suffix) {
				hasSuffix++
			}
		}
		// At least some should have prefix (directional sampling = ~13/18) and most should have suffix
		expect(hasPrefix).toBeGreaterThan(5)
		expect(hasSuffix).toBeGreaterThan(30)
	})

	it("house_number is included most of the time", () => {
		const rng = seededRandom(7)
		let withHN = 0

		for (let i = 0; i < 100; i++) {
			const r = synthesizeStreetRow(
				{ locality: "Chicago", region: "IL", postcode: "60601", country: "US" },
				{ random: rng }
			)

			if (r!.components.house_number) {
				withHN++
			}
		}
		// Default 0.85 — allow noise
		expect(withHN).toBeGreaterThan(70)
		expect(withHN).toBeLessThan(95)
	})

	it("raw string is the assembled address", () => {
		const r = synthesizeStreetRow(
			{ locality: "Burlington", region: "VT", postcode: "05401", country: "US" },
			{ random: seededRandom(42), includeHouseNumberProb: 0.0 }
		)
		expect(r!.raw).toContain("Burlington")
		expect(r!.raw).toContain("VT")
		expect(r!.raw).toContain("05401")
		// No house_number when prob=0
		expect(r!.components.house_number).toBeUndefined()
	})

	it("non-US returns null", () => {
		const r = synthesizeStreetRow(
			{ locality: "Paris", region: "Île-de-France", postcode: "75001", country: "FR" },
			{ random: seededRandom(1) }
		)
		expect(r).toBeNull()
	})
})
