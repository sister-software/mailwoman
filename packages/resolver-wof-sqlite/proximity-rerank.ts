/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The proximity re-rank (#938): with bias hints — the demo's map viewport, a user location — re-order exact-match
 *   candidates by population and nearness on one additive scale, so an in-view namesake wins a tie without a hard
 *   filter. Byte-identical to plain population order when no bias is passed.
 *
 *   This lives in its own platform-free module because it has to run identically in two places: the Node candidate
 *   reader and the browser byte-range twin. That is the #861 server↔demo parity contract, and it is the second thing
 *   here held by construction rather than by comment (`primary-preference.ts` was the first). Constants alone were not
 *   enough — the two copies agreed on every literal and still diverged on which field the population term reads and on
 *   whether the combined value is written back, which is the half that actually decides the answer.
 *
 *   Two properties are required and easy to lose when transcribing:
 *
 *   1. The population base is `prominence ?? score`, NOT `score`. `prominence` carries the bounded cross-country
 *      primary preference, so reading raw score lets a coincidental foreign alias ride population back over a primary
 *      whenever a viewport hint happens to be present.
 *   2. The combined value is PERSISTED into `prominence`. The resolver walk re-sorts by `prominence ?? score`, so a
 *      caller that only returns the array in bias order has its ordering silently discarded downstream.
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
 * `log10(population + 1)` at which the population term saturates — 6 means a population of one million earns the whole
 * {@link POP_BOOST}, and larger populations earn no more.
 */
export const POP_SCALE_LOG10 = 6

/**
 * Distance at which the nearness term halves.
 *
 * SHARPER than the FTS reader's 100 km on purpose: the candidate backend's score is log-population ALONE, with no bm25
 * document term, so the population signal is weaker relative to the bias and a gentle 100 km decay let a 230 km-distant
 * alias-exact township ("Paris Township", OH) edge out a global city ("Paris", FR) from a nearby view. At ~30 km the
 * boost reaches only candidates the user is actually looking at: an in-view namesake still wins (Dublin, OH from an
 * Ohio view), a distant one no longer does (Paris stays FR from a Michigan view).
 */
export const PROX_SCALE_KM = 30

/**
 * One bias hint — a coordinate the user is looking at or standing on, optionally weighted.
 */
export interface ProximityBias {
	lat: number
	lon: number
	weight?: number
}

/**
 * The candidate fields the re-rank reads and writes. Structural rather than a concrete candidate type, so the Node
 * reader's `PlaceCandidate` and the browser twin's row shape both satisfy it without an adapter.
 */
export interface ProximityRerankable {
	lat: number
	lon: number
	score: number
	prominence?: number
}

/**
 * Population plus nearness on one additive scale. Exported for tests and for a caller that wants the value without the
 * sort; ordinary callers want {@link applyProximityRerank}.
 */
export function combinedProminence(candidate: ProximityRerankable, bias: readonly ProximityBias[]): number {
	const popBase = candidate.prominence ?? candidate.score
	const popTerm = POP_BOOST * Math.min(1, Math.max(0, popBase) / POP_SCALE_LOG10)
	let proxTerm = 0

	// A candidate at the null island has no coordinate, not a coordinate at 0,0 — it earns no nearness term rather
	// than an enormous one.
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
 * Re-order `candidates` in place by {@link combinedProminence}, persisting each combined value into `prominence` so the
 * resolver walk's own `prominence ?? score` sort carries the bias order rather than undoing it. Stable within equal
 * prominence, preserving the population order the index already gave. A caller with no bias hints must not call this —
 * the no-bias path is plain population order by construction.
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
		// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array; toSorted would double-allocate on a hot path
		.sort((a, b) => b.p - a.p || a.i - b.i)
		.forEach((x, j) => (candidates[j] = x.c))

	return candidates
}
