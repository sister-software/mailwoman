/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Small stats helpers — the canonical home for the `percentile`/`median` copies (~15) and the
 *   `pct` percentage-format lambdas (~40) the 2026-07-09 dedupe survey found across eval scripts.
 *
 *   `percentile` is byte-for-byte the gate scripts' nearest-rank implementation
 *   (oa-resolver-eval.ts / resolver-eval.ts) — gate parity depends on this exact semantics; do not
 *   "upgrade" it to linear interpolation.
 */

/** Nearest-rank percentile over an unsorted sample; `null` on an empty sample. `p` in [0, 100]. */
export function percentile(xs: readonly number[], p: number): number | null {
	if (xs.length === 0) return null
	const s = [...xs].sort((a, b) => a - b)

	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}

/** `percentile(xs, 50)`. */
export function median(xs: readonly number[]): number | null {
	return percentile(xs, 50)
}

/** Format `numerator / denominator` as a fixed-digit percentage (`"12.5%"`); `"—"` when `denominator` is 0. */
export function formatPercent(numerator: number, denominator: number, digits = 1): string {
	if (denominator === 0) return "—"

	return ((100 * numerator) / denominator).toFixed(digits) + "%"
}
