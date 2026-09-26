/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Lossless decomposition: the typed-`unknown`-span primitive. Every byte of the input belongs to exactly one
 *   segment — a span some node covers, or an `unknown` run the model left all-O. Those all-O runs are what
 *   `decodeAsJSON` silently drops, and surfacing them lets a consumer route them to fallback logic, display them, or
 *   aggregate them.
 *
 *   This is the pure primitive: it reads `tree.raw` and node `[start,end)` ranges and returns the complement,
 *   mutating no state and changing no serializer.
 */
import { walkNodes } from "#decoder/tree/walk"
import type { AddressTree } from "#decoder/types"

export interface UnknownSpan {
	kind: "unknown"
	value: string
	/**
	 * Inclusive start char offset into `tree.raw`.
	 */
	start: number
	/**
	 * Exclusive end char offset into `tree.raw`.
	 */
	end: number
}

/**
 * One tile of the lossless decomposition: a run that some node covers, or an `unknown` gap.
 */
export interface LosslessSegment {
	kind: "covered" | "unknown"
	value: string
	start: number
	end: number
}

function coveredMask(tree: AddressTree): Uint8Array {
	const len = tree.raw.length
	const covered = new Uint8Array(len)

	for (const n of walkNodes(tree.roots)) {
		const lo = Math.max(0, n.start)
		const hi = Math.min(len, n.end)

		for (let i = lo; i < hi; i++) {
			covered[i] = 1
		}
	}

	return covered
}

/**
 * Tile `tree.raw` into maximal covered/unknown runs, in source order; the concatenation
 * of the segment values reproduces `tree.raw` exactly ({@link isLossless}).
 */
export function losslessSegments(tree: AddressTree): LosslessSegment[] {
	const len = tree.raw.length

	if (len === 0) return []
	const covered = coveredMask(tree)
	const out: LosslessSegment[] = []
	let i = 0

	while (i < len) {
		const kind = covered[i] ? "covered" : "unknown"
		let j = i + 1

		while (j < len && !!covered[j] === !!covered[i]) {
			j++
		}

		out.push({ kind, value: tree.raw.slice(i, j), start: i, end: j })
		i = j
	}

	return out
}

/**
 * The all-O runs no node covers, as typed `unknown` spans, in source order —
 * the complement of the node coverage over `tree.raw`.
 */
export function unknownSpans(tree: AddressTree): UnknownSpan[] {
	return losslessSegments(tree)
		.filter((s) => s.kind === "unknown")
		.map((s) => ({ kind: "unknown" as const, value: s.value, start: s.start, end: s.end }))
}

/**
 * The round-trip guarantee: concatenating the lossless segments (covered + unknown),
 * in order, reproduces the original input.
 *
 * Holds by construction unless a node span overshoots the input bounds.
 */
export function isLossless(tree: AddressTree): boolean {
	return (
		losslessSegments(tree)
			.map((s) => s.value)
			.join("") === tree.raw
	)
}
