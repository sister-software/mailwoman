/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tree-shape predicates over an `AddressTree`, the shared stack walk behind the pipeline's
 *   bare-tree guards and the lone bare toponym conditions.
 *
 *   - {@link isBareTreeOf} holds every value-containing node to the given tag. Several tags are
 *     allowed.
 *   - {@link loneValueNode} answers with the tree's single value-containing node.
 */

import type { ComponentTag } from "@mailwoman/codex/component"

import { flatten } from "#decoder/serialize/tuples"
import { walkNodes } from "#decoder/tree/walk"
import type { AddressNode, AddressTree } from "#decoder/types"

/**
 * True when every node in the tree either has `tag` or bears no value.
 *
 * A tag-matching node counts even when its value is empty.
 * The guard asks whether the parser emitted this shape.
 *
 * Any other tag with a non-empty value disqualifies.
 * False for a tree with no `tag` node at all.
 */
export function isBareTreeOf(tree: AddressTree, tag: ComponentTag): boolean {
	let sawTag = false

	for (const node of walkNodes(tree.roots)) {
		if (node.tag === tag) {
			sawTag = true
		} else if (node.value.trim() !== "") return false
	}

	return sawTag
}

/**
 * The tree's single value-containing node, or null when the tree holds none or more than one.
 *
 * Callers check on the returned node's `tag`.
 * The quantifier ("this is the whole query") is what this walk answers.
 */
export function loneValueNode(tree: AddressTree): AddressNode | null {
	let lone: AddressNode | null = null

	for (const node of walkNodes(tree.roots)) {
		if (node.value.trim().length) {
			if (lone !== null) return null
			lone = node
		}
	}

	return lone
}

/**
 * One flattened node, projected for display.
 *
 * A structural copy rather than the `AddressNode` itself: a consumer rendering
 * a span list must not be handed the live node.
 * Its `children` and `metadata` invite a walk it has already been given the result of.
 */
export interface FlatTreeNode {
	tag: ComponentTag
	value: string
	confidence: number
	start: number
	end: number
	/**
	 * Where the assertion came from, one of `rule`, `neural`, `resolver`.
	 *
	 * Included because a span that keeps its tag, its text and its confidence while its
	 * source moves from `resolver` to `neural` has lost its gazetteer backing.
	 * A projection that drops this reports that span as unchanged.
	 */
	source?: string
	sourceID?: string
	/**
	 * The resolver's answer for this span, when one won.
	 *
	 * Included for the same reason `source` is.
	 * A projection that keeps only the text and the tag cannot tell a span that resolved
	 * to a different place from one that did not move at all.
	 *
	 * `alternatives` is reduced to its length.
	 * Consumers read the retrieval breadth.
	 *
	 * Candidate objects would invite a walk that this projection already performed.
	 */
	placeID?: string
	lat?: number
	lon?: number
	alternatives?: number
}

/**
 * Flatten a tree to its nodes in source order, sorted by `start`, the order `decodeAsTuples` means.
 *
 * A traversal-order walk is the obvious implementation and is wrong here.
 * It coincides with source order only while every parent's span precedes its children's.
 * The decoder does not promise that ordering.
 *
 * The tuple projection already sorts the results, so the same order makes a rendered
 * span list and `decodeAsTuples` agree by construction.
 */
export function flattenTreeNodes(tree?: AddressTree | null): FlatTreeNode[] {
	if (!tree) return []

	const all: AddressNode[] = []

	for (const root of tree.roots) {
		flatten(root, all)
	}

	return all
		.map((node) => ({
			tag: node.tag,
			value: node.value,
			confidence: node.confidence,
			start: node.start,
			end: node.end,
			...(node.source === undefined ? {} : { source: node.source }),
			...(node.sourceID === undefined ? {} : { sourceID: node.sourceID }),
			...(node.placeID === undefined ? {} : { placeID: node.placeID }),
			...(node.lat === undefined ? {} : { lat: node.lat }),
			...(node.lon === undefined ? {} : { lon: node.lon }),
			...(node.alternatives === undefined ? {} : { alternatives: node.alternatives.length }),
		}))
		.toSorted((a, b) => a.start - b.start)
}
