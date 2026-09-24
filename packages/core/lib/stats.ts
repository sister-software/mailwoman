/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Statistical helpers for percentiles, averages, and percentages.
 */

/**
 * Return the nearest-rank percentile for `p` in [0, 100], or `null` for an empty sample.
 */
export function percentile(xs: readonly number[], p: number): number | null {
	if (!xs.length) return null
	const s = [...xs].toSorted((a, b) => a - b)

	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}

/**
 * Return the median using the nearest-rank percentile rule.
 */
export function median(xs: readonly number[]): number | null {
	return percentile(xs, 50)
}

/**
 * Format a ratio as a percentage.
 *
 * A zero denominator renders `"—"` unless `zero` is `"clamp"`.
 */
export function formatPercent(
	numerator: number,
	denominator: number,
	digits = 1,
	options?: { zero?: "dash" | "clamp" }
): string {
	if (denominator === 0) {
		if (options?.zero !== "clamp") return "—"

		return (100 * numerator).toFixed(digits) + "%"
	}

	return ((100 * numerator) / denominator).toFixed(digits) + "%"
}

/**
 * Return the arithmetic mean, or `null` for an empty list.
 */
export function mean(xs: readonly number[]): number | null {
	if (!xs.length) return null

	return xs.reduce((sum, x) => sum + x, 0) / xs.length
}

/**
 * Return a nearest-rank percentile from an ascending list without copying it.
 */
export function percentileSorted(sorted: readonly number[], p: number): number | null {
	if (!sorted.length) return null

	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
}
