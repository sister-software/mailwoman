/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Lossless decomposition (#493) — the typed-`unknown`-span primitive. Every byte of the input belongs to
 *   exactly one segment: a span some node covers, or an `unknown` run the model left all-O. Those all-O runs
 *   are what `decodeAsJson` silently drops (the JSON-hides-gaps trap) — surfacing them lets a consumer route
 *   them to fallback logic, display them, or aggregate them as the self-reporting corpus-gap detector.
 *
 *   This is the PURE primitive: it reads `tree.raw` + node `[start,end)` ranges and returns the complement.
 *   It mutates nothing and changes no serializer — wiring `unknown` into the JSON/XML/tuple contracts + the
 *   demo is the focused follow-up (#493). Byte-stable by construction, so it ships ahead of that work.
 */
import type { AddressNode, AddressTree } from "./types.js"

export interface UnknownSpan {
	kind: "unknown"
	value: string
	/** Inclusive start char offset into `tree.raw`. */
	start: number
	/** Exclusive end char offset into `tree.raw`. */
	end: number
}

/** One tile of the lossless decomposition: a run that some node covers, or an `unknown` gap. */
export interface LosslessSegment {
	kind: "covered" | "unknown"
	value: string
	start: number
	end: number
}

/** Mark every char index `tree.raw` that any node's `[start,end)` covers (nesting overlaps merge naturally). */
function coveredMask(tree: AddressTree): Uint8Array {
	const len = tree.raw.length
	const covered = new Uint8Array(len)
	const stack: AddressNode[] = [...tree.roots]

	while (stack.length > 0) {
		const n = stack.pop()!
		const lo = Math.max(0, n.start)
		const hi = Math.min(len, n.end)

		for (let i = lo; i < hi; i++) covered[i] = 1

		for (const c of n.children) stack.push(c)
	}

	return covered
}

/**
 * Tile `tree.raw` into maximal covered/unknown runs, in source order. The concatenation of the segment values
 * reproduces `tree.raw` exactly — that is the #493 round-trip invariant ({@link isLossless}).
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

		while (j < len && !!covered[j] === !!covered[i]) j++
		out.push({ kind, value: tree.raw.slice(i, j), start: i, end: j })
		i = j
	}

	return out
}

/**
 * The all-O runs no node covers, as typed `unknown` spans, in source order. The complement of the node coverage over
 * `tree.raw`.
 */
export function unknownSpans(tree: AddressTree): UnknownSpan[] {
	return losslessSegments(tree)
		.filter((s) => s.kind === "unknown")
		.map((s) => ({ kind: "unknown" as const, value: s.value, start: s.start, end: s.end }))
}

/**
 * The #493 round-trip guarantee: concatenating the lossless segments (covered + unknown), in order, reproduces the
 * original input. Holds by construction unless a node span overshoots the input bounds.
 */
export function isLossless(tree: AddressTree): boolean {
	return (
		losslessSegments(tree)
			.map((s) => s.value)
			.join("") === tree.raw
	)
}
