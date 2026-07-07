/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Order-preserving tuple projection.
 *
 *   Emits `Array<[tag, value]>` in source order (sorted by `start`). Preserves repeated tags (e.g.
 *   two `locality` entries for "Springfield, IL — sent from Springfield, MA"). Hierarchy is lost —
 *   use `decodeAsXML` when containment matters.
 */

import type { ComponentTag } from "../types/component.js"
import type { AddressNode, AddressTree } from "./types.js"
import { unknownSpans } from "./unknown-spans.js"

/** Options for {@link decodeAsTuples}. */
export interface SerializeTuplesOpts {
	/**
	 * Interleave `["unknown", value]` tuples for the all-O spans the model left unclassified (#493), in source order.
	 * Default false — keeps the existing tag-only shape unless the caller asks for the gaps.
	 */
	includeUnknown?: boolean
}

function flatten(node: AddressNode, out: AddressNode[]): void {
	out.push(node)

	for (const child of node.children) {
		flatten(child, out)
	}
}

/** Project an `AddressTree` to a source-ordered list of (tag, value) pairs. */
export function decodeAsTuples(tree: AddressTree): Array<[ComponentTag, string]>
export function decodeAsTuples(tree: AddressTree, opts: SerializeTuplesOpts): Array<[ComponentTag | "unknown", string]>
export function decodeAsTuples(
	tree: AddressTree,
	opts: SerializeTuplesOpts = {}
): Array<[ComponentTag | "unknown", string]> {
	const all: AddressNode[] = []

	for (const root of tree.roots) {
		flatten(root, all)
	}

	const entries: Array<{ start: number; tuple: [ComponentTag | "unknown", string] }> = all.map((n) => ({
		start: n.start,
		tuple: [n.tag, n.value],
	}))

	if (opts.includeUnknown) {
		for (const u of unknownSpans(tree)) {
			entries.push({ start: u.start, tuple: ["unknown", u.value] })
		}
	}

	entries.sort((a, b) => a.start - b.start)

	return entries.map((e) => e.tuple)
}
