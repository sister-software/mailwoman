/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pure render helpers for `<ModelVisualizer>` — kept free of React so they unit-test without a
 *   DOM. Color output is CSS `hsl()` strings chosen to read on both light and dark Docusaurus
 *   themes (mid-lightness, alpha-scaled).
 */

/** Conventions-mask sentinel (classifier.ts writes -1e9 ≈ log 0 into masked cells). */
const MASK_SENTINEL_FLOOR = -1e8

/** Numerically-stable softmax over one logit row. */
export function softmaxRow(row: number[]): number[] {
	if (row.length === 0) return []
	const max = Math.max(...row)
	const exps = row.map((v) => Math.exp(v - max))
	const sum = exps.reduce((a, b) => a + b, 0)

	return exps.map((v) => v / sum)
}

/** Largest |value| in a matrix, ignoring mask sentinels. Returns 1 for empty input (safe divisor). */
export function matrixAbsMax(matrix: number[][]): number {
	let max = 0

	for (const row of matrix) {
		for (const v of row) {
			if (v <= MASK_SENTINEL_FLOOR) continue

			const abs = Math.abs(v)

			if (abs > max) max = abs
		}
	}

	return max === 0 ? 1 : max
}

/** True when a cell was removed from the vocabulary by the conventions mask. */
export function isMasked(value: number): boolean {
	return value <= MASK_SENTINEL_FLOOR
}

/**
 * Diverging heat color: positive → teal, negative → orange, 0 → transparent. `value` is clamped
 * to ±absMax; intensity rides the alpha channel so the cell text stays legible.
 */
export function emissionColor(value: number, absMax: number): string {
	const t = Math.max(-1, Math.min(1, value / absMax))
	const alpha = Math.abs(t) * 0.85

	return t >= 0 ? `hsl(174 60% 40% / ${(alpha * 100).toFixed(0)}%)` : `hsl(24 85% 50% / ${(alpha * 100).toFixed(0)}%)`
}

/** `B-street` → `street`, `I-street` → `street`, `O` → `O`. */
export function stripBIO(label: string): string {
	return label.replace(/^[BI]-/, "")
}

/** Replace the SentencePiece space sentinel (`▁`, U+2581) with a visible open-box marker. */
export function pieceDisplay(piece: string): string {
	return piece.replace(/▁/g, "␣")
}

/** Indices where two index-aligned label sequences disagree. */
export function changedIndices(before: string[], after: string[]): number[] {
	const out: number[] = []
	const len = Math.max(before.length, after.length)

	for (let i = 0; i < len; i++) {
		if (before[i] !== after[i]) out.push(i)
	}

	return out
}
