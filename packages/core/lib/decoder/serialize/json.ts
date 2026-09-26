/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Libpostal-compatible JSON projection.
 *
 *   Flattens the tree to `{ tag: value }`, first occurrence winning for a repeated tag, which matches libpostal.
 *   Use `decodeAsTuples` if order or repetition matters.
 *
 *   A multi-role node — a city-state span tagged `region` that also plays `locality` — emits one entry per role
 *   from its `interpretations`, so `out.locality` still surfaces for a completed city-state; every role shares the
 *   span's `value`.
 */

import type { ComponentTag } from "@mailwoman/codex/component"

import { slotNodes } from "#decoder/tree/walk"
import type { AddressNode, AddressTree } from "#decoder/types"
import { type UnknownSpan, unknownSpans } from "#decoder/unknown-spans"

/**
 * A span the flat projection could not represent, and why.
 *
 * The flat map holds one value per tag, so a tree carrying two `locality` spans emits one
 * and the other ceases to exist: `region: null` then means both "the input named no region"
 * and "the input named one, we parsed it, and the projection deleted it".
 */
export interface DroppedSpan {
	/**
	 * The tag the span carried; always one already present in the output,
	 * because a drop happens only when the slot was taken.
	 */
	tag: ComponentTag
	/**
	 * The value that was discarded.
	 */
	value: string
	/**
	 * The value that held the slot, so a reader can see which of the two survived without re-walking the tree.
	 */
	kept: string
}

/**
 * Options for {@link decodeAsJSON}.
 */
export interface SerializeJSONOpts {
	/**
	 * Add an `unknown` array of the all-O spans the model left unclassified; default false keeps
	 * the output libpostal-compatible (a flat tag→value map) unless the caller asks for the gaps.
	 */
	includeUnknown?: boolean
	/**
	 * Add a `dropped` array naming every span first-occurrence-wins discarded;
	 * default false keeps the output libpostal-compatible, and the geocode path opts in
	 * because a silently deleted component is the one thing a caller cannot recover for itself.
	 */
	includeDropped?: boolean
}

/**
 * Place one node's tag (and its alternative interpretations) into the flat map,
 * first occurrence winning, and receipt every span the taken slot deletes.
 */
function place(node: AddressNode, out: Partial<Record<ComponentTag, string>>, dropped: DroppedSpan[]): void {
	if (node.tag in out) {
		if (out[node.tag] !== node.value) {
			dropped.push({ tag: node.tag, value: node.value, kept: out[node.tag]! })
		}
	} else {
		out[node.tag] = node.value
	}

	if (node.interpretations) {
		for (const interp of node.interpretations) {
			if (!(interp.tag in out)) {
				out[interp.tag] = node.value
			} else if (out[interp.tag] !== node.value) {
				dropped.push({ tag: interp.tag, value: node.value, kept: out[interp.tag]! })
			}
		}
	}
}

/**
 * Project an `AddressTree` to a flat libpostal-style component map.
 */
export function decodeAsJSON(tree: AddressTree): Partial<Record<ComponentTag, string>>

export function decodeAsJSON(
	tree: AddressTree,
	opts: SerializeJSONOpts
): Partial<Record<ComponentTag, string>> & { unknown?: UnknownSpan[]; dropped?: DroppedSpan[] }

export function decodeAsJSON(
	tree: AddressTree,
	opts: SerializeJSONOpts = {}
): Partial<Record<ComponentTag, string>> & { unknown?: UnknownSpan[]; dropped?: DroppedSpan[] } {
	const out: Partial<Record<ComponentTag, string>> & { unknown?: UnknownSpan[]; dropped?: DroppedSpan[] } = {}
	const dropped: DroppedSpan[] = []

	// Grounded spans first, then text order — the same order the named result slots read (tree-shape.ts).
	for (const node of slotNodes(tree.roots)) {
		place(node, out, dropped)
	}

	// Always emit `unknown`, even `[]`, when asked, so a consumer that opted in can iterate it without a presence check.
	if (opts.includeUnknown) {
		out.unknown = unknownSpans(tree)
	}

	// Always emitted when asked, `[]` included, so a caller that has to presence-check
	// cannot tell "no field was dropped" from "this build does not report drops".
	if (opts.includeDropped) {
		out.dropped = dropped
	}

	return out
}
