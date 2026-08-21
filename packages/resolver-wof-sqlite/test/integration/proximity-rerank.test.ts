/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The #861 server↔demo parity contract, pinned at the two properties that were NOT held when the Node reader and the
 *   browser byte-range twin each carried their own transcription of this re-rank. Both copies agreed on all four
 *   constants. They disagreed on which field the population term reads and on whether the combined value is written
 *   back — so a test that compares constants would have passed throughout.
 */

import {
	applyProximityRerank,
	combinedProminence,
	type ProximityRerankable,
} from "@mailwoman/resolver-wof-sqlite/proximity-rerank"
import { describe, expect, it } from "vitest"

/**
 * A million-population primary and a coincidental foreign alias of the same name. `prominence` below `score` on the
 * alias is the bounded cross-country primary-preference penalty, already applied upstream.
 */
function contestedPair(): ProximityRerankable[] {
	return [
		{ lat: 48.8566, lon: 2.3522, score: 6.3, prominence: 6.3 },
		{ lat: 40, lon: -83, score: 4, prominence: 0.5 },
	]
}

describe("applyProximityRerank", () => {
	it("reads the penalized prominence, so a demoted alias does not ride population back over a primary", () => {
		const [primary, demoted] = contestedPair()
		// A viewport ~10 km off the alias — the ordinary case, not the degenerate one. At distance 0 the nearness
		// term saturates at BIAS_BOOST and outruns the whole population range either way, so the field the
		// population term reads only decides the answer at real viewport distances. It decides it over a wide band:
		// the alias wins out to ~59 km on raw score and only to ~2.6 km on the penalized value.
		const bias = [{ lat: 40.09, lon: -83 }]
		const rawScorePopTerm = 4 * Math.min(1, demoted!.score / 6)
		const penalizedPopTerm = 4 * Math.min(1, demoted!.prominence! / 6)
		const proxTerm = combinedProminence(demoted!, bias) - penalizedPopTerm

		expect(combinedProminence(demoted!, bias)).toBeLessThan(combinedProminence(primary!, bias))
		// ...and the transcription this replaced, reading raw score, would have picked the alias.
		expect(rawScorePopTerm + proxTerm).toBeGreaterThan(combinedProminence(primary!, bias))
	})

	it("still lets an in-view namesake win when it was never demoted", () => {
		const distantBig: ProximityRerankable = { lat: 48.8566, lon: 2.3522, score: 6.3, prominence: 6.3 }
		const nearSmall: ProximityRerankable = { lat: 40, lon: -83, score: 4.7, prominence: 4.7 }
		const ranked = applyProximityRerank([distantBig, nearSmall], [{ lat: 40.01, lon: -83.01 }])

		expect(ranked[0]).toBe(nearSmall)
	})

	it("persists the combined value into prominence, so the resolver walk's own sort carries the bias order", () => {
		const candidates = contestedPair()
		const before = candidates.map((c) => c.prominence)

		applyProximityRerank(candidates, [{ lat: 40, lon: -83 }])

		// The walk re-sorts by `prominence ?? score`. A re-rank that only returned bias order would leave these
		// untouched and have its ordering discarded downstream.
		expect(candidates.map((c) => c.prominence)).not.toEqual(before)
		expect(candidates.every((c) => typeof c.prominence === "number")).toBe(true)
	})

	it("gives a null-island candidate no nearness term", () => {
		const nowhere: ProximityRerankable = { lat: 0, lon: 0, score: 4, prominence: 4 }
		const bias = [{ lat: 0.001, lon: 0.001 }]

		// Population term only: 4 * (4 / 6).
		expect(combinedProminence(nowhere, bias)).toBeCloseTo(4 * (4 / 6), 10)
	})

	it("falls back to score when a backend carries no prominence", () => {
		const bare: ProximityRerankable = { lat: 10, lon: 10, score: 3 }

		expect(combinedProminence(bare, [])).toBeCloseTo(4 * (3 / 6), 10)
	})

	it("is stable within equal prominence, preserving the index order", () => {
		const a: ProximityRerankable = { lat: 10, lon: 10, score: 5, prominence: 5 }
		const b: ProximityRerankable = { lat: 10, lon: 10, score: 5, prominence: 5 }

		expect(applyProximityRerank([a, b], [{ lat: 10, lon: 10 }])).toEqual([a, b])
	})
})
