/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The evidence constructors and the one rule they enforce.
 */

import { Assertion, observation, prior, relation } from "@mailwoman/evidence"
import { describe, expect, it } from "vitest"

describe("evidence constructors", () => {
	it("an observation carries source and vintage and never a score", () => {
		const e = observation("os-open-uprn", "2026-08", { uprn: 100_023_336_956 })

		expect(e.kind).toBe("observation")
		expect(e.source).toBe("os-open-uprn")
		expect(e.vintage).toBe("2026-08")
		expect(e).not.toHaveProperty("score")
	})

	it("a prior carries a weight and cannot claim a vintage it does not have", () => {
		const e = prior("population", "urbanisation", 0.4)

		expect(e.kind).toBe("prior")
		expect(e.weight).toBe(0.4)
		expect(e).not.toHaveProperty("vintage")
	})

	// filer.db enforces this in SQL (`filer_family_match_score_inferred_only`). The same rule has to hold here or the
	// two disagree the moment a caller builds a Relation outside the database.
	it("an authoritative relation refuses a score", () => {
		expect(() =>
			relation({
				source: "edgar-exhibit-21",
				vintage: "2026-08-07",
				relationship: "subsidiary",
				assertion: Assertion.Authoritative,
				score: 0.9,
			})
		).toThrow(/authoritative relation cannot carry a score/i)
	})

	it("an inferred relation accepts a score, and an unscored one carries no score key", () => {
		const scored = relation({
			source: "form-499",
			vintage: "2025-12-07",
			relationship: "parent_company",
			assertion: Assertion.Inferred,
			score: 0.82,
		})

		const unscored = relation({
			source: "form-499",
			vintage: "2025-12-07",
			relationship: "parent_company",
			assertion: Assertion.Inferred,
		})

		expect(scored.assertion).toBe("inferred")
		expect(scored.score).toBe(0.82)
		expect(unscored).not.toHaveProperty("score")
	})
})
