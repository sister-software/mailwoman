/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for the invariance mini-suite's component comparator — pure, no model, no I/O.
 */

import { describe, expect, it } from "vitest"

import { compareComponents } from "./compare.ts"

describe("compareComponents", () => {
	it("is INVARIANT on an exact match", () => {
		const a = { house_number: "1600", street: "Pennsylvania Ave NW", locality: "Washington", postcode: "20500" }
		const b = { house_number: "1600", street: "Pennsylvania Ave NW", locality: "Washington", postcode: "20500" }

		expect(compareComponents(a, b).verdict).toBe("INVARIANT")
	})

	it("is INVARIANT under whitespace/case-only differences (normalized before comparison)", () => {
		const a = { street: "Pennsylvania Ave NW", locality: "Washington" }
		const b = { street: "  pennsylvania  ave nw", locality: "WASHINGTON" }

		expect(compareComponents(a, b).verdict).toBe("INVARIANT")
	})

	it("is LOST when the transformed parse is completely empty", () => {
		const a = { house_number: "1600", street: "Pennsylvania Ave NW" }

		expect(compareComponents(a, {}).verdict).toBe("LOST")
	})

	it("is NOT LOST when both sides are empty (nothing to lose)", () => {
		expect(compareComponents({}, {}).verdict).toBe("INVARIANT")
	})

	it("is LOST when a critical tag's value changes — the Pennsylvania Ave comma-drop shape", () => {
		// Reproduces the feed-8k finding: comma-drop pulls "NW" out of `street` and into `locality`.
		const a = { house_number: "1600", street: "Pennsylvania Ave NW", locality: "Washington", region: "DC" }
		const b = {
			house_number: "1600",
			street: "Pennsylvania",
			street_suffix: "Ave",
			locality: "NW Washington",
			region: "DC",
		}

		const result = compareComponents(a, b)

		expect(result.verdict).toBe("LOST")
		expect(result.diff.some((d) => d.startsWith("street:"))).toBe(true)
	})

	it("is LOST when house_number changes", () => {
		const a = { house_number: "1600", street: "Main St" }
		const b = { house_number: "1601", street: "Main St" }

		expect(compareComponents(a, b).verdict).toBe("LOST")
	})

	it("is LOST when postcode changes", () => {
		const a = { street: "Main St", postcode: "20500" }
		const b = { street: "Main St", postcode: "20501" }

		expect(compareComponents(a, b).verdict).toBe("LOST")
	})

	it("does not treat a critical tag absent from the ORIGINAL as broken just because it's absent in both", () => {
		const a = { street: "Rue Montmartre", locality: "Paris" }
		const b = { street: "Rue Montmartre", locality: "Paris" }

		expect(compareComponents(a, b).verdict).toBe("INVARIANT")
	})

	it("is LOST when a critical tag is ABSENT in the original but PRESENT in the transformed parse — hallucination", () => {
		// A hallucinated house_number/street/postcode can resolve to a SPECIFIC WRONG rooftop — worse than a
		// fallback to a coarser admin tier, so this is LOST even though nothing "changed" in the more
		// familiar sense of a present value drifting. (Adjudicated: review fix wave, 2026-07-23.)
		const a = { street: "Rue Montmartre", locality: "Paris" }
		const b = { street: "Rue Montmartre", locality: "Paris", postcode: "75001" }

		const result = compareComponents(a, b)

		expect(result.verdict).toBe("LOST")
		expect(result.diff.some((d) => d.includes("hallucinated"))).toBe(true)
	})

	it("is DEGRADED when only a non-critical tag drifts", () => {
		const a = { house_number: "41", street: "Hightree Drive", locality: "Macclesfield", dependent_locality: "Henbury" }
		const b = { house_number: "41", street: "Hightree Drive", locality: "Macclesfield", dependent_locality: "" }

		expect(compareComponents(a, b).verdict).toBe("DEGRADED")
	})

	it("is DEGRADED when a new non-critical tag appears", () => {
		const a = { house_number: "41", street: "Hightree Drive" }
		const b = { house_number: "41", street: "Hightree Drive", unit: "Flat 2" }

		expect(compareComponents(a, b).verdict).toBe("DEGRADED")
	})

	it("diff lines are human-readable and non-empty for every violation", () => {
		const a = { street: "Main St", locality: "Springfield" }
		const b = { street: "Main St", locality: "Shelbyville" }

		const result = compareComponents(a, b)

		expect(result.verdict).toBe("DEGRADED")
		expect(result.diff.length).toBeGreaterThan(0)
		expect(result.diff[0]).toContain("locality")
	})
})
