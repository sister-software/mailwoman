/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   V0 -> AddressTree adapter (Direction C, Phase 1 — the linchpin).
 *
 *   The WOF resolver's `resolveTree` consumes an `AddressTree` (neural's native, nested,
 *   containment-bearing output). The v0 rule parser emits a FLAT `ClassificationRecord` ({tag:
 *   string[]}) with no hierarchy and no char spans. To put v0's parse through the same resolver —
 *   and run the "v0-via-adapter" baseline that tests whether the capability map's clean-input win
 *   translates end-to-end — we must turn that flat record into a tree.
 *
 *   Strategy: locate each component value's char span in the raw text, synthesize one `B-<tag>`
 *   DecoderToken per value, then hand them to the canonical `buildAddressTree` so the SAME
 *   containment logic (`PARENT_OF`, nearest-parent attachment) that nests neural output also nests
 *   v0's — keeping the two baselines comparable. We deliberately reuse buildAddressTree rather than
 *   re-implement nesting; a divergent nester would confound the comparison.
 *
 *   Faithfulness note: a regex/rule parser may normalize values (casing, abbreviation expansion) so a
 *   value isn't a verbatim substring of raw. We fall back to case-insensitive search; a value we
 *   still can't place is dropped (logged via the return's `dropped` count). The preliminary gate
 *   (v0-via-adapter >= 85% of v0 standalone component accuracy on canonical) catches an adapter
 *   that drops too much.
 */

import { buildAddressTree, type AddressTree, type DecoderToken } from "@mailwoman/core/decoder"
import type { ClassificationRecord } from "mailwoman"

export interface AdaptResult {
	tree: AddressTree
	/** Component values that could not be located in raw and were dropped. */
	dropped: number
}

/** Find `value` in `raw` at or after `from`, case-insensitive fallback. Returns [start,end) or null. */
function locate(raw: string, value: string, from: number): [number, number] | null {
	if (!value) return null
	let i = raw.indexOf(value, from)
	if (i < 0) {
		// case-insensitive fallback (v0 may upper/lower-case components)
		const lower = raw.toLowerCase().indexOf(value.toLowerCase(), from)
		if (lower < 0) {
			// last resort: search from the start (value may appear before the cursor)
			const any = raw.toLowerCase().indexOf(value.toLowerCase())
			if (any < 0) return null
			i = any
		} else {
			i = lower
		}
	}
	return [i, i + value.length]
}

/**
 * Convert a v0 flat `ClassificationRecord` into an `AddressTree` by synthesizing char-aligned
 * `B-<tag>` tokens and running the canonical tree builder. Values are placed left-to-right with a
 * cursor so repeated values ("New York, New York") don't collide on the same span.
 */
export function v0RecordToTree(raw: string, record: ClassificationRecord): AdaptResult {
	// Collect (tag, value) pairs, then place them in order of first appearance so the cursor walk
	// assigns leftmost-first (matches how the string reads).
	const pairs: Array<{ tag: string; value: string }> = []
	for (const [tag, values] of Object.entries(record)) {
		for (const value of values ?? []) pairs.push({ tag, value })
	}

	const placements: Array<{ tag: string; start: number; end: number }> = []
	let dropped = 0
	// Greedy left-to-right: for each pair (sorted by earliest possible position), claim the next
	// free occurrence past the cursor. Sorting by first-occurrence keeps multi-value order sane.
	pairs.sort((a, b) => {
		const ia = raw.toLowerCase().indexOf(a.value.toLowerCase())
		const ib = raw.toLowerCase().indexOf(b.value.toLowerCase())
		return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib)
	})
	let cursor = 0
	for (const { tag, value } of pairs) {
		const span = locate(raw, value, cursor)
		if (!span) {
			dropped++
			continue
		}
		placements.push({ tag, start: span[0], end: span[1] })
		cursor = Math.max(cursor, span[1])
	}

	placements.sort((a, b) => a.start - b.start)
	const tokens: DecoderToken[] = placements.map((p) => ({
		piece: raw.slice(p.start, p.end),
		start: p.start,
		end: p.end,
		label: `B-${p.tag}` as DecoderToken["label"],
		confidence: 1,
	}))

	return { tree: buildAddressTree(raw, tokens), dropped }
}
