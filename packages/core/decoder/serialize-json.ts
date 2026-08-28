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

import type { ComponentTag } from "../types/component.ts"
import type { AddressNode, AddressTree } from "./types.ts"
import { type UnknownSpan, unknownSpans } from "./unknown-spans.ts"

/**
 * A span the flat projection could not represent, and why.
 *
 * The flat map holds one value per tag, so a tree carrying two `locality` spans emits one and the other ceases to
 * exist. `region: null` then means BOTH "the input named no region" and "the input named one, we parsed it, and the
 * projection deleted it" — and #1755 is what that costs: the #1748 trailing region is PARSED, tagged `locality`, and
 * dropped here, which is why no decode lever could ever move that class.
 */
export interface DroppedSpan {
	/**
	 * The tag the span carried. Always one already present in the output — a drop happens because the slot was taken.
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
	 * Add an `unknown` array of the all-O spans the model left unclassified (#493). Default false — keeps the output
	 * libpostal-compatible (a flat tag→value map) unless the caller asks for the gaps.
	 */
	includeUnknown?: boolean
	/**
	 * Add a `dropped` array naming every span first-occurrence-wins discarded (#1755). Default false, keeping the output
	 * libpostal-compatible; the geocode path opts in, because a silently deleted component is the one thing a caller
	 * cannot recover for itself.
	 */
	includeDropped?: boolean
}

function visit(node: AddressNode, out: Partial<Record<ComponentTag, string>>, dropped: DroppedSpan[]): void {
	if (node.tag in out) {
		// The slot is taken and this span is about to cease to exist. Record it BEFORE the recursion, so the order of
		// `dropped` follows the walk rather than the tree's depth.
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

	for (const child of node.children) {
		visit(child, out, dropped)
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

	for (const root of tree.roots) {
		visit(root, out, dropped)
	}

	// Always emit `unknown` (even `[]`) when asked — a consumer that opted in can iterate it without a
	// presence check. Omitting-when-empty was a libpostal-flat-map instinct that doesn't fit the opt-in path.
	if (opts.includeUnknown) {
		out.unknown = unknownSpans(tree)
	}

	// Always emitted when asked, `[]` included — the same reasoning as `unknown` above, and required here: a caller
	// that has to presence-check cannot tell "nothing was dropped" from "this build does not report drops".
	if (opts.includeDropped) {
		out.dropped = dropped
	}

	return out
}
