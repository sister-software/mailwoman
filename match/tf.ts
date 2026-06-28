/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Term-frequency adjustment — making a rare-value agreement count more than a common one.
 *
 *   Two people both named "Vijayan" is far stronger evidence of a match than two both named "Smith",
 *   because "Smith" agreements happen by chance all the time and "Vijayan" agreements don't. The
 *   Fellegi-Sunter `m` (how often a true match agrees) is roughly the same either way; what differs
 *   is `u` — the chance a _non_-match agrees — which for an exact agreement on value `v` is just
 *   how common `v` is. So we leave `m`, and replace the level's average `u` with `frequency(v)`,
 *   adding `log2(u_level / frequency(v))` to the weight: a big positive bump for rare values, a
 *   penalty for common ones.
 *
 *   Crucially for a label-free matcher: the frequencies are computed ON-THE-FLY from the input column
 *   (the Splink approach) — no external Census table required. Build a {@link TermFrequencyTable}
 *   from the values you're matching, then attach it to a comparison with {@link withTermFrequency}.
 */

import type { Comparison, TermFrequencyAdjustment } from "./fellegi-sunter.js"

/** A lookup of how common each value is, in (0, 1], built from a column of observed values. */
export interface TermFrequencyTable {
	/** Relative frequency of a value (its normalized form), or 0 if never seen. */
	frequency(value: string): number
	/** Total observations the table was built from. */
	readonly total: number
	/** Number of distinct normalized values. */
	readonly distinct: number
}

const defaultNormalize = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, " ")

/**
 * Build a {@link TermFrequencyTable} from an iterable of values (e.g. every `given` name in the dataset). Values are
 * normalized (default: trim + lowercase + collapse whitespace) before counting, and `frequency()` normalizes its
 * argument the same way, so callers pass raw field values.
 */
export function buildTermFrequencyTable(
	values: Iterable<string | null | undefined>,
	opts: { normalize?: (value: string) => string } = {}
): TermFrequencyTable {
	const normalize = opts.normalize ?? defaultNormalize
	const counts = new Map<string, number>()
	let total = 0

	for (const value of values) {
		if (value == null) continue
		const key = normalize(value)

		if (!key) continue
		counts.set(key, (counts.get(key) ?? 0) + 1)
		total++
	}

	return {
		total,
		distinct: counts.size,
		frequency(value) {
			if (total === 0) return 0

			return (counts.get(normalize(value)) ?? 0) / total
		},
	}
}

/**
 * Attach a term-frequency adjustment to a comparison. By default it applies to the exact level (index 0) and looks up
 * the value via `value(a, b)` — usually the agreeing field extracted from one side. Returns a new comparison; the
 * underlying `assess` and levels are untouched, so this composes with EM (which re-estimates the base `m`/`u` the
 * adjustment sits on top of).
 */
export function withTermFrequency<R>(
	comparison: Comparison<R>,
	config: {
		table: TermFrequencyTable
		value: (a: R, b: R) => string | null | undefined
		/** Level indices to adjust. Default `[0]` (the exact level). */
		levels?: Iterable<number>
		/** Scale in [0, 1]. Default 1. */
		weight?: number
		/** Frequency floor bounding the boost on ultra-rare values. Default 1e-4. */
		minimumFrequency?: number
	}
): Comparison<R> {
	const adjustment: TermFrequencyAdjustment<R> = {
		frequency: (value) => config.table.frequency(value),
		levels: new Set(config.levels ?? [0]),
		value: config.value,
		weight: config.weight,
		minimumFrequency: config.minimumFrequency,
	}

	return { ...comparison, termFrequency: adjustment }
}
