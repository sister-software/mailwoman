/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Re-order exact-match candidates by population and nearness on one additive scale when bias hints
 *   are present (the demo's map viewport, a user location), so an in-view namesake wins a tie
 *   without a hard filter. With no bias the order is plain population order, byte-identical.
 *
 *   This lives in its own platform-free module because it has to run identically in two places, the
 *   Node candidate reader and the browser byte-range twin. That is the server and demo parity
 *   interface held by construction. Constants by themselves were not enough, since the two copies agreed on
 *   every literal and still diverged on which field the population term reads and on whether the
 *   combined value is written back.
 *
 *   Two properties are required and easy to lose when transcribing:
 *
 *   1. The population base is `prominence ?? score`. `prominence` contains the bounded cross-country
 *      primary preference, so reading raw score lets a coincidental foreign alias ride population
 *      back over a primary whenever a viewport hint happens to be present.
 *   2. The combined value is persisted into `prominence`. The resolver walk re-sorts by
 *      `prominence ?? score`, so a caller that only returns the array in bias order has its
 *      ordering silently discarded downstream.
 */

import { haversineKm } from "@mailwoman/spatial"

/**
 * Full magnitude of the nearness term at distance 0, before decay.
 */
export const BIAS_BOOST = 4

/**
 * Full magnitude of the population term, reached at {@link POP_SCALE_LOG10} and capped there.
 */
export const POP_BOOST = 4

/**
 * `log10(population + 1)` at which the population term saturates.
 *
 * A value of 6 means a population of one million warrants the whole {@link POP_BOOST},
 * and larger populations warrant no more.
 */
export const POP_SCALE_LOG10 = 6

/**
 * Distance at which the nearness term halves.
 *
 * Sharper than the FTS reader's 100 km on purpose, because the candidate backend's
 * score is log-population by itself with no bm25 document term.
 * This weakens the population signal relative to the bias.
 *
 * At around 30 km the boost reaches only candidates the user is looking at,
 * so an in-view namesake still wins and a distant one does not.
 */
export const PROX_SCALE_KM = 30

/**
 * One bias hint, a coordinate the user is looking at or standing on, optionally weighted.
 */
export interface ProximityBias {
	lat: number
	lon: number
	weight?: number
}

/**
 * The candidate fields the re-rank reads and writes.
 *
 * This is structural, so the Node reader's `PlaceCandidate` and the browser twin's
 * row shape both satisfy it without an adapter.
 */
export interface ProximityRerankable {
	lat: number
	lon: number
	score: number
	prominence?: number
}

/**
 * Population plus nearness on one additive scale.
 *
 * Exported for tests and for a caller that wants the value without the sort.
 * Ordinary callers want {@link applyProximityRerank}.
 */
export function combinedProminence(candidate: ProximityRerankable, bias: readonly ProximityBias[]): number {
	const popBase = candidate.prominence ?? candidate.score
	const popTerm = POP_BOOST * Math.min(1, Math.max(0, popBase) / POP_SCALE_LOG10)
	let proxTerm = 0

	// A candidate at the null island has no coordinate, so it warrants no nearness term.
	// A 0,0 pair interpreted as a real coordinate would receive an enormous score.
	if (!(candidate.lat === 0 && candidate.lon === 0)) {
		for (const b of bias) {
			const d = haversineKm(b.lat, b.lon, candidate.lat, candidate.lon)
			const term = (BIAS_BOOST * (b.weight ?? 1)) / (1 + d / PROX_SCALE_KM)

			if (term > proxTerm) {
				proxTerm = term
			}
		}
	}

	return popTerm + proxTerm
}

/**
 * Re-order `candidates` in place by {@link combinedProminence}, persisting each
 * combined value into `prominence` so the resolver walk's own `prominence ?? score`
 * sort preserves the bias order rather than undoing it.
 *
 * Stable within equal prominence, preserving the population order the index already gave.
 * A caller with no bias hints must not call this.
 * The no-bias path is plain population order by construction.
 */
export function applyProximityRerank<T extends ProximityRerankable>(
	candidates: T[],
	bias: readonly ProximityBias[]
): T[] {
	candidates
		.map((c, i) => {
			c.prominence = combinedProminence(c, bias)

			return { c, i, p: c.prominence }
		})
		// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array. toSorted would double-allocate on a hot path
		.sort((a, b) => b.p - a.p || a.i - b.i)
		.forEach((x, j) => (candidates[j] = x.c))

	return candidates
}
