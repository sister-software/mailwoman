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
 * Format `numerator / denominator` as a fixed-digit percentage (`"12.5%"`); `"—"` when `denominator` is 0.
 */
export function formatPercent(numerator: number, denominator: number, digits = 1): string {
	if (denominator === 0) return "—"

	return ((100 * numerator) / denominator).toFixed(digits) + "%"
}
