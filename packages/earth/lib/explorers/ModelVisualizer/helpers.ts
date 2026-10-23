/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pure render helpers for `<ModelVisualizer>` — kept free of React so they unit-test without a
 *   DOM. Color output is CSS `hsl()` strings chosen to read on both light and dark Docusaurus
 *   themes (mid-lightness, alpha-scaled).
 */

import { isPresent } from "@mailwoman/core/objects"
import type { TraceTokenLike } from "mailwoman/browser-runtime/types"

/**
 * Conventions-mask sentinel (classifier.ts writes -1e9 ≈ log 0 into masked cells).
 */
const MASK_SENTINEL_FLOOR = -1e8

/**
 * Largest |value| in a matrix, ignoring mask sentinels.
 *
 * @returns 1 for empty input (safe divisor).
 */
export function matrixAbsMax(matrix: number[][]): number {
	let max = 0

	for (const row of matrix) {
		for (const v of row) {
			if (v <= MASK_SENTINEL_FLOOR) continue

			const abs = Math.abs(v)

			if (abs > max) {
				max = abs
			}
		}
	}

	return max === 0 ? 1 : max
}

/**
 * True when a cell was removed from the vocabulary by the conventions mask.
 */
export function isMasked(value: number): boolean {
	return value <= MASK_SENTINEL_FLOOR
}

/**
 * The diverging heat scale uses teal for positive values, orange for negative values
 * and transparency for zero.
 *
 * `value` is clamped to ±absMax.
 * Intensity uses the alpha channel so the cell text stays legible.
 */
export function emissionColor(value: number, absMax: number): string {
	const t = Math.max(-1, Math.min(1, value / absMax))
	const alpha = Math.abs(t) * 0.85

	return t >= 0 ? `hsl(174 60% 40% / ${(alpha * 100).toFixed(0)}%)` : `hsl(24 85% 50% / ${(alpha * 100).toFixed(0)}%)`
}

/**
 * Replace the SentencePiece space sentinel (`▁`, U+2581) with a visible open-box marker.
 */
export function pieceDisplay(piece: string): string {
	return piece.replaceAll("▁", "␣")
}

/**
 * Indices where two index-aligned label sequences disagree.
 */
export function changedIndices(before: string[], after: string[]): number[] {
	const out: number[] = []
	const len = Math.max(before.length, after.length)

	for (let i = 0; i < len; i++) {
		if (before[i] !== after[i]) {
			out.push(i)
		}
	}

	return out
}

/**
 * The tag inside a BIO label, so `B-locality` and `I-locality` read as one family.
 */
export function labelFamily(label: string): string {
	return label.replace(/^[BI]-/, "")
}

/**
 * The distinct label families of a model's label list, in the order the list introduces them, without `O`.
 */
export function familyOrder(labels: readonly string[]): string[] {
	const out: string[] = []

	for (const label of labels) {
		const family = labelFamily(label)

		if (family === "O" || out.includes(family)) continue

		out.push(family)
	}

	return out
}

/**
 * The golden angle in degrees.
 *
 * Consecutive multiples of it spread around the color wheel without two landing close.
 */
const GOLDEN_ANGLE = 137.508

/**
 * A hue on the color wheel for a label family, or `null` for `O` and a family outside `order`.
 *
 * Families take hues in golden-angle steps along `order`, so neighbors in the label list
 * land far apart and a family keeps one hue across every band of a trace.
 */
export function labelHue(label: string, order: readonly string[]): number | null {
	const index = order.indexOf(labelFamily(label))

	if (index === -1) return null

	return Math.round((index * GOLDEN_ANGLE) % 360)
}

/**
 * The words of an input as tiles.
 *
 * Whitespace, newlines included, splits them, and punctuation stays on the word it touches.
 */
export function tilesOf(text: string): string[] {
	return text.split(/\s+/u).filter(isPresent)
}

/**
 * The tiles with the one at `from` moved to sit at `to`, as a drag onto that slot does.
 */
export function moveTile(tiles: readonly string[], from: number, to: number): string[] {
	const next = [...tiles]
	const [tile] = next.splice(from, 1)

	if (tile == null) return next

	next.splice(to, 0, tile)

	return next
}

export interface LabelFlip {
	piece: string
	before: string
	after: string
}

/**
 * The tokens whose label changed when one tile was removed, matched by
 * where each token starts in the base text.
 *
 * `removedStart` is the tile's offset in the base text and `removedLength` the count
 * of characters its removal took out, the tile plus one separating space.
 * A probe token at or past `removedStart` sits `removedLength` characters earlier than its base twin.
 *
 * A probe token with no twin at its mapped start, because the removal re-tokenized
 * its neighbor, is left out rather than counted.
 */
export function flipsAfterRemoval(
	base: readonly TraceTokenLike[],
	probe: readonly TraceTokenLike[],
	removedStart: number,
	removedLength: number
): LabelFlip[] {
	const baseByStart = new Map(base.map((token) => [token.start, token]))
	const out: LabelFlip[] = []

	for (const token of probe) {
		const start = token.start < removedStart ? token.start : token.start + removedLength
		const twin = baseByStart.get(start)

		if (!twin || twin.label === token.label) continue

		out.push({ piece: token.piece, before: twin.label, after: token.label })
	}

	return out
}

/**
 * The index of the token whose character span covers `offset`, or -1 for a character between tokens.
 */
export function coveringTokenIndex(tokens: readonly { start: number; end: number }[], offset: number): number {
	return tokens.findIndex((token) => offset >= token.start && offset < token.end)
}

/**
 * The best label on one emissions row other than the chosen one, with the chosen label's lead over it.
 *
 * Masked cells (the conventions-mask sentinel) are skipped, so a label the address
 * system forbids is never reported as a near miss.
 * Answers `null` when the row holds no second unmasked label.
 */
export function runnerUp(
	row: readonly number[],
	labels: readonly string[],
	chosen: number
): { index: number; label: string; gap: number } | null {
	let best = -1

	for (let i = 0; i < row.length; i++) {
		if (i === chosen || isMasked(row[i]!)) continue

		if (best === -1 || row[i]! > row[best]!) {
			best = i
		}
	}

	if (best === -1) return null

	return { index: best, label: labels[best] ?? `#${best}`, gap: (row[chosen] ?? 0) - row[best]! }
}
