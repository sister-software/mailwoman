/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Row-to-pair fold/dedupe/skip logic for the PIX1 placetype-pair index.
 *   Extracted from `commands/gazetteer/pair-index.tsx` so it can be unit tested
 *   with in-memory rows.
 *
 *   {@link PairIndexBuilder} processes one (rawCity, rawDistrict) row at a time.
 *   The child is always `dependent_locality`. Empty city rows are skipped.
 *   Both fields are folded with `normalizeFSTToken`.
 *
 *   `parentTag` is provided by the caller per row and is never defaulted.
 *
 *   Also tracks the pre-fold city word-count distribution for window sizing.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import { SeededRandom } from "@mailwoman/core/random"
import { normalizeFSTToken } from "@mailwoman/neural/fst-prior"
import type { PairIndexEntry } from "@mailwoman/neural/pair"

/**
 * Child tag emitted by this arc.
 *
 * Parent tag is passed per row (see {@link PairIndexBuilder.addRow}).
 */
const PAIR_TAG = "dependent_locality"

/**
 * One word-length bucket for raw city values.
 */
export interface WordLengthBucket {
	words: number
	rows: number
}

/**
 * Percentiles and histogram for raw (pre-fold) city word lengths.
 */
export interface CityWordLengthDistribution {
	/**
	 * Number of non-empty city rows used.
	 */
	totalRows: number
	p50: number
	p90: number
	p99: number
	max: number
	/**
	 * Buckets sorted by `words` ascending.
	 */
	counts: WordLengthBucket[]
}

export interface PairIndexBuildResult {
	/**
	 * Deduplicated (child, parent) pairs.
	 */
	entries: PairIndexEntry[]
	/**
	 * Rows with a non-empty city.
	 */
	rowsKept: number
	/**
	 * Rows skipped because city was empty.
	 */
	rowsSkipped: number
	distribution: CityWordLengthDistribution
}

/**
 * Nearest-rank percentile for an ascending-sorted array.
 *
 * `p` in `[0, 100]`.
 * Throws for empty input.
 */
export function nearestRankPercentile(sortedAscending: readonly number[], p: number): number {
	if (!sortedAscending.length) {
		throw new Error("nearestRankPercentile: empty input")
	}

	const rank = Math.min(sortedAscending.length, Math.max(1, Math.ceil((p / 100) * sortedAscending.length)))

	return sortedAscending[rank - 1]!
}

/**
 * Incrementally folds rows into deduplicated PIX1 entries, tracking skips and city word lengths.
 *
 * Use one instance per build.
 * Call {@link addRow} per row, then {@link finish}.
 */
export class PairIndexBuilder {
	readonly #seen = new Map<string, PairIndexEntry>()
	readonly #wordLengths: number[] = []
	#rowsKept = 0
	#rowsSkipped = 0

	/**
	 * Fold one source row.
	 *
	 * `rawCity`/`rawDistrict` are raw CSV values (trimmed defensively here).
	 * Empty city rows are skipped.
	 *
	 * `parentTag` is required and caller-supplied.
	 */
	addRow(rawCity: string, rawDistrict: string, parentTag: ComponentTag): void {
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
			// Folded child is empty (for example, punctuation-only input).
			return
		}

		// Length-prefixed key avoids delimiter collisions when names contain spaces.
		const key = `${child.length}:${child}:${parent}`

		// First write wins for duplicate (child, parent) pairs.
		if (!this.#seen.has(key)) {
			this.#seen.set(key, { child, parent, tag: PAIR_TAG, parentTag })
		}
	}

	/**
	 * Finalize and return deduplicated entries plus word-length distribution.
	 */
	/**
	 * Number of distinct (child, parent) pairs accumulated so far.
	 */
	get distinctCount(): number {
		return this.#seen.size
	}

	finish(): PairIndexBuildResult {
		const sortedLengths = [...this.#wordLengths].toSorted((a, b) => a - b)
		const histogram = new Map<number, number>()

		for (const w of sortedLengths) {
			histogram.set(w, (histogram.get(w) ?? 0) + 1)
		}

		const counts: WordLengthBucket[] = [...histogram.entries()]
			.toSorted(([a], [b]) => a - b)
			.map(([words, rows]) => ({ words, rows }))

		const distribution: CityWordLengthDistribution = sortedLengths.length
			? {
					totalRows: sortedLengths.length,
					p50: nearestRankPercentile(sortedLengths, 50),
					p90: nearestRankPercentile(sortedLengths, 90),
					p99: nearestRankPercentile(sortedLengths, 99),
					max: sortedLengths.at(-1)!,
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
	/**
	 * Entries to serialize (full set minus holdout).
	 */
	kept: PairIndexEntry[]
	/**
	 * Entries withheld from the build.
	 */
	heldOut: PairIndexEntry[]
}

/**
 * Deterministically withhold a fraction of entries.
 *
 * Used for eval/falsifier runs.
 *
 * Not for shipped builds (`fraction: 0` there).
 *
 * Order-independent and seed-deterministic: sort, then seeded shuffle.
 *
 * `fraction` is clamped to `[0, 1]`; holdout count is `Math.round(fraction * entries.length)`.
 */
export function applyPairIndexHoldout(
	entries: readonly PairIndexEntry[],
	fraction: number,
	seed: number
): PairIndexHoldoutResult {
	const clamped = Math.min(1, Math.max(0, fraction))

	if (clamped === 0 || !entries.length) {
		return { kept: [...entries], heldOut: [] }
	}

	const sorted = [...entries].toSorted((a, b) =>
		a.child < b.child ? -1 : a.child > b.child ? 1 : a.parent < b.parent ? -1 : a.parent > b.parent ? 1 : 0
	)

	new SeededRandom(seed).shuffle(sorted)

	const holdoutCount = Math.round(clamped * sorted.length)

	return { heldOut: sorted.slice(0, holdoutCount), kept: sorted.slice(holdoutCount) }
}
