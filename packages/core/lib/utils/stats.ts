/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Statistical helpers using nearest-rank percentiles.
 */

/**
 * Nearest-rank percentile over an unsorted sample; `null` on an empty sample. `p` in [0, 100].
 */
export function percentile(xs: readonly number[], p: number): number | null {
	if (!xs.length) return null
	const s = [...xs].toSorted((a, b) => a - b)

	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}

/**
 * `percentile(xs, 50)`.
 */
export function median(xs: readonly number[]): number | null {
	return percentile(xs, 50)
}

/**
 * Format `numerator / denominator` as a fixed-digit percentage (`"12.5%"`). A zero denominator renders the absence
 * marker `"—"` by default; `zero: "clamp"` divides by 1 instead, for reports where an empty bucket should read `"0%"`
 * rather than as an absence.
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
 * The arithmetic mean, or null for an empty list — the same absence convention as {@link percentile}.
 */
export function mean(xs: readonly number[]): number | null {
	if (!xs.length) return null

	return xs.reduce((sum, x) => sum + x, 0) / xs.length
}

/**
 * {@link percentile} over an ALREADY-SORTED ascending list — same nearest-rank convention, no copy, for the callers that
 * sort once and read many percentiles.
 */
export function percentileSorted(sorted: readonly number[], p: number): number | null {
	if (!sorted.length) return null

	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
}
