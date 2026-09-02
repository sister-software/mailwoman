/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `classifyRescueRow` — the pure half of the retrieval-rescue census (#1878).
 *
 *   Each case pins a distinction the summary would otherwise blur. The COMER pair is the live instance the census
 *   exists for: a wrong delivered answer with the correct entity on hand, silenced by the incumbent-resolved check.
 */

import { classifyRescueRow, type RescueRowInput, summarizeRescue } from "mailwoman/eval-harness/retrieval-rescue-census"
import { describe, expect, it } from "vitest"

// The COMER truth pin: 96 Rue d'Hauteville, 75010 Paris (fr-fork-entity-comer, tolerance 1000 m).
const PARIS = { expectLat: 48.8773422, expectLon: 2.3516751, expectToleranceM: 1000 }

function row(overrides: Partial<RescueRowInput>): RescueRowInput {
	return { lat: null, lon: null, entityFired: false, alternateCandidates: [], ...overrides }
}

describe("classifyRescueRow", () => {
	it("classifies the COMER placebo shape: wrong resolvable pick, correct entity gated off", () => {
		// The placebo delivered Comer, Georgia, US (34.062167, -83.126341) — ~7,000 km from truth — while the
		// unconditional probe holds the restaurant 6 m away.
		const graded = classifyRescueRow(
			row({
				...PARIS,
				lat: 34.062167,
				lon: -83.126341,
				unconditionalEntityHit: { lat: 48.87735372, lon: 2.35159664 },
			})
		)

		expect(graded.classification).toBe("rescue_available_entity")
		expect(graded.deliveredKm).toBeGreaterThan(6000)
		expect(graded.gateProtects).toBe(false)
	})

	it("classifies the COMER shipped shape: entity fired under the current gate, answer correct", () => {
		const graded = classifyRescueRow(row({ ...PARIS, lat: 48.87735372, lon: 2.35159664, entityFired: true }))

		expect(graded.classification).toBe("entity_rescued_already")
	})

	it("finds a rank rescue among the alternates and reports the rank", () => {
		const graded = classifyRescueRow(
			row({
				...PARIS,
				lat: 34.062167,
				lon: -83.126341,
				alternateCandidates: [
					{ lat: 51.5, lon: -0.12 },
					{ lat: 48.8774, lon: 2.3517 },
				],
			})
		)

		expect(graded.classification).toBe("rescue_available_rank")
		expect(graded.rescueRank).toBe(2)
	})

	it("keeps gate_protects a SEPARATE flag on a correct row with an entity hit", () => {
		// Loosening the check reorders which mechanism answers even when both are right — that row belongs in the
		// risk list without leaving the correct_as_is count.
		const graded = classifyRescueRow(
			row({
				...PARIS,
				lat: 48.8774,
				lon: 2.3517,
				unconditionalEntityHit: { lat: 48.87735372, lon: 2.35159664 },
			})
		)

		expect(graded.classification).toBe("correct_as_is")
		expect(graded.gateProtects).toBe(true)
	})

	it("keeps an unresolved wrong row with nothing on hand out of every rescue bucket", () => {
		const graded = classifyRescueRow(row({ ...PARIS }))

		expect(graded.classification).toBe("no_rescue_on_hand")
		expect(graded.deliveredKm).toBeUndefined()
	})

	it("marks a truthless row ungraded rather than guessing", () => {
		expect(classifyRescueRow(row({ lat: 1, lon: 1 })).classification).toBe("ungraded")
	})
})

describe("summarizeRescue", () => {
	it("counts every class and the gate-protects flag with the row total as denominator", () => {
		const reports = [
			{ id: "a", input: "a", markers: [], classification: "correct_as_is" as const, gateProtects: true },
			{ id: "b", input: "b", markers: [], classification: "rescue_available_entity" as const, gateProtects: false },
			{ id: "c", input: "c", markers: [], classification: "ungraded" as const, gateProtects: false },
		]

		const summary = summarizeRescue(reports)

		expect(summary.rows).toBe(3)
		expect(summary.graded).toBe(2)
		expect(summary.counts.rescue_available_entity).toBe(1)
		expect(summary.gateProtects).toBe(1)
	})
})
