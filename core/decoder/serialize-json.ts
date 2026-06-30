/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Libpostal-compatible JSON projection.
 *
 *   Flattens the tree to `{ tag: value }`. First-occurrence wins for repeated tags — matches
 *   libpostal's behavior. Use `decodeAsTuples` if order or repetition matters.
 *
 *   A multi-role node (#413 — a city-state span tagged `region` that also plays `locality`) emits one
 *   entry per role from its `interpretations`, so `out.locality` still surfaces for a completed
 *   city-state. The shared span means every role gets the same `value`.
 */

import type { ComponentTag } from "../types/component.js"
import type { AddressNode, AddressTree } from "./types.js"
import { type UnknownSpan, unknownSpans } from "./unknown-spans.js"

/** Options for {@link decodeAsJson}. */
export interface SerializeJsonOpts {
	/**
	 * Add an `unknown` array of the all-O spans the model left unclassified (#493). Default false — keeps the output
	 * libpostal-compatible (a flat tag→value map) unless the caller asks for the gaps.
	 */
	includeUnknown?: boolean
}

function visit(node: AddressNode, out: Partial<Record<ComponentTag, string>>): void {
	if (!(node.tag in out)) out[node.tag] = node.value

	if (node.interpretations) {
		for (const interp of node.interpretations) {
			if (!(interp.tag in out)) out[interp.tag] = node.value
		}
	}

	for (const child of node.children) visit(child, out)
}

/** Project an `AddressTree` to a flat libpostal-style component map. */
export function decodeAsJson(
	tree: AddressTree,
	opts: SerializeJsonOpts = {}
): Partial<Record<ComponentTag, string>> & { unknown?: UnknownSpan[] } {
	const out: Partial<Record<ComponentTag, string>> & { unknown?: UnknownSpan[] } = {}

	for (const root of tree.roots) visit(root, out)

	if (opts.includeUnknown) {
		const gaps = unknownSpans(tree)

		if (gaps.length > 0) out.unknown = gaps
	}

	return out
}
