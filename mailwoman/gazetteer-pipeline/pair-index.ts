/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pure row→pair fold/dedupe/skip logic for the PIX1 placetype-pair index (placetype-pair-prior
 *   arc, Task 3). Extracted out of `commands/gazetteer/pair-index.tsx` so it's unit-testable against
 *   plain in-memory rows — the command itself only owns CSV streaming + CLI plumbing + the file
 *   write.
 *
 *   {@link PairIndexBuilder} consumes one (rawCity, rawDistrict) row at a time — child = CITY,
 *   parent = DISTRICT, tag always `dependent_locality` (the PPD-tuples shape this arc's GB shard
 *   reads: CITY is the dependent_locality candidate, DISTRICT the enclosing post town — see
 *   `corpus/src/shard-recipes/locale.ts`'s `districtAsLocality` gate). A row with an empty CITY (the
 *   PPD majority — the dependent_locality is legitimately absent on most rows) is skipped: it carries
 *   no dependent_locality to pair. Both fields are folded through `normalizeFSTToken` (the single
 *   fold this arc's Task 1 exported), matching `PairIndexHeader.foldVersion` — the same fold the PIX1
 *   reader's caller (`fst-prior.ts`'s `groupPiecesIntoWords`) applies at query time.
 *
 *   Also tracks the pre-fold CITY word-length distribution (whitespace-split word count per raw,
 *   non-empty CITY) — this sizes the word-span window Task 4's decode-side prior walks (a
 *   dependent_locality candidate rarely spans more than a handful of words; the p99 here is the
 *   evidence for that window, not a guess).
 */

import { SeededRandom } from "@mailwoman/core/utils"
import { normalizeFSTToken } from "@mailwoman/neural/fst-prior"
import type { PairIndexEntry } from "@mailwoman/neural/pair-index-resolver"

/** The one tag this arc's GB extraction ever emits — CITY-under-DISTRICT is always a dependent_locality candidate. */
const PAIR_TAG = "dependent_locality" as const

/** One row-length bucket: `words` whitespace-split tokens, seen on `rows` raw CITY values. */
export interface WordLengthBucket {
	words: number
	rows: number
}

/** Percentile summary of the raw (pre-fold) CITY word-length distribution, plus the full per-length histogram. */
export interface CityWordLengthDistribution {
	/** Non-empty CITY rows the distribution was computed over. */
	totalRows: number
	p50: number
	p90: number
	p99: number
	max: number
	/** Sorted ascending by `words`. */
	counts: WordLengthBucket[]
}

export interface PairIndexBuildResult {
	/** Deduplicated (child, parent) pairs, ready for `serializePairIndex`. */
	entries: PairIndexEntry[]
	/** Rows that contributed a pair (non-empty CITY after trim). */
	rowsKept: number
	/** Rows dropped for an empty CITY. */
	rowsSkipped: number
	distribution: CityWordLengthDistribution
}

/**
 * Nearest-rank percentile over an ASCENDING-sorted array (matches the convention `docs/articles/evals` percentile
 * tables use). `p` in `[0, 100]`. Throws on an empty array — there's no percentile of nothing, and a silent `0` would
 * hide the empty-input bug from the caller.
 */
export function nearestRankPercentile(sortedAscending: readonly number[], p: number): number {
	if (sortedAscending.length === 0) {
		throw new Error("nearestRankPercentile: empty input")
	}

	const rank = Math.min(sortedAscending.length, Math.max(1, Math.ceil((p / 100) * sortedAscending.length)))

	return sortedAscending[rank - 1]!
}

/**
 * Incrementally folds (rawCity, rawDistrict) rows into deduplicated PIX1 entries, tracking the skip count and the raw
 * CITY word-length distribution. One instance per build; call {@link addRow} per source row, then {@link finish} once.
 */
export class PairIndexBuilder {
	readonly #seen = new Map<string, PairIndexEntry>()
	readonly #wordLengths: number[] = []
	#rowsKept = 0
	#rowsSkipped = 0

	/**
	 * Fold one source row. `rawCity`/`rawDistrict` are the UNFOLDED CSV cell values (already `.trim()`-ed by the caller's
	 * CSV read is fine either way — this trims again defensively). A row with an empty CITY is skipped: PPD's DISTRICT
	 * (post town) is populated on virtually every row, but CITY (dependent_locality) legitimately isn't, and an empty
	 * child has nothing to pair.
	 */
	addRow(rawCity: string, rawDistrict: string): void {
		const trimmedCity = rawCity.trim()

		if (!trimmedCity) {
			this.#rowsSkipped++

			return
		}

		this.#rowsKept++
		this.#wordLengths.push(trimmedCity.split(/\s+/).length)

		const child = normalizeFSTToken(trimmedCity)
		const parent = normalizeFSTToken(rawDistrict.trim())

		if (!child) {
			// Folds to nothing (e.g. a CITY that was pure punctuation) — nothing left to index.
			return
		}

		// Length-prefixed key (mirrors pair-index-resolver.ts's `pairKey`): folded names can contain spaces, so a plain
		// delimiter could collide two distinct (child, parent) splits onto the same joined string.
		const key = `${child.length}:${child}:${parent}`

		if (!this.#seen.has(key)) {
			this.#seen.set(key, { child, parent, tag: PAIR_TAG })
		}
	}

	/** Finalize the build: deduplicated entries (sort order left to `serializePairIndex`) + the word-length distribution. */
	finish(): PairIndexBuildResult {
		const sortedLengths = [...this.#wordLengths].sort((a, b) => a - b)
		const histogram = new Map<number, number>()

		for (const w of sortedLengths) {
			histogram.set(w, (histogram.get(w) ?? 0) + 1)
		}

		const counts: WordLengthBucket[] = [...histogram.entries()]
			.sort(([a], [b]) => a - b)
			.map(([words, rows]) => ({ words, rows }))

		const distribution: CityWordLengthDistribution =
			sortedLengths.length > 0
				? {
						totalRows: sortedLengths.length,
						p50: nearestRankPercentile(sortedLengths, 50),
						p90: nearestRankPercentile(sortedLengths, 90),
						p99: nearestRankPercentile(sortedLengths, 99),
						max: sortedLengths[sortedLengths.length - 1]!,
						counts,
					}
				: { totalRows: 0, p50: 0, p90: 0, p99: 0, max: 0, counts: [] }

		return {
			entries: [...this.#seen.values()],
			rowsKept: this.#rowsKept,
			rowsSkipped: this.#rowsSkipped,
			distribution,
		}
	}
}

export interface PairIndexHoldoutResult {
	/** Entries to actually serialize into the index — the full set MINUS the held-out fraction. */
	kept: PairIndexEntry[]
	/** Entries withheld from the build — the falsifier-board holdout set (placetype-pair-prior arc, Task 6). */
	heldOut: PairIndexEntry[]
}

/**
 * Deterministically withhold a `fraction` of `entries` from a pair-index build — the pair-holdout falsifier (Task 6):
 * "rebuild the GB index minus a random 10% of pairs (seed 42)" so the acceptance bars can be re-anchored against a
 * measured degradation curve rather than an assumed one. Dev/eval-only — never wired into a real shipped-artifact build
 * (a shipped index always has `fraction: 0`, i.e. holds out nothing).
 *
 * Order-independent and seed-deterministic: entries are sorted by (child, parent) BEFORE the seeded shuffle (mirrors
 * {@link serializePairIndex}'s own sort), so the same `(fraction, seed)` pair always withholds the same entries
 * regardless of what order the caller's `entries` array arrives in (e.g. `Map` iteration order, which
 * {@link PairIndexBuilder.finish} does not guarantee is stable across runs/engines).
 *
 * `fraction` is clamped to `[0, 1]`; `Math.round(fraction * entries.length)` entries are withheld — rounds to 0 (a
 * no-op holdout) on a fraction too small to withhold even one entry from a small input.
 */
export function applyPairIndexHoldout(
	entries: readonly PairIndexEntry[],
	fraction: number,
	seed: number
): PairIndexHoldoutResult {
	const clamped = Math.min(1, Math.max(0, fraction))

	if (clamped === 0 || entries.length === 0) {
		return { kept: [...entries], heldOut: [] }
	}

	const sorted = [...entries].sort((a, b) =>
		a.child < b.child ? -1 : a.child > b.child ? 1 : a.parent < b.parent ? -1 : a.parent > b.parent ? 1 : 0
	)

	new SeededRandom(seed).shuffle(sorted)

	const holdoutCount = Math.round(clamped * sorted.length)

	return { heldOut: sorted.slice(0, holdoutCount), kept: sorted.slice(holdoutCount) }
}
