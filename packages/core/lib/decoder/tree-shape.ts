/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tree-SHAPE predicates over an `AddressTree` — the one stack walk behind the pipeline's bare-tree
 *   guards and the "lone bare toponym" conditions. Two quantifiers cover every consumer:
 *
 *   - {@link isBareTreeOf} — every value-bearing node carries the given tag (several allowed). The
 *     #912 / #1589 posture guards (`isBareLocalityTree`, `isBarePostcodeTree`) are this with the tag
 *     bound.
 *   - {@link loneValueBearingNode} — the tree has EXACTLY one value-bearing node. The street-miss
 *     fallback and the resolver's bare-country race bind the tag at the call site.
 *
 *   The distinction is required: a two-segment parse can satisfy the first and never the second,
 *   and both behaviors are pinned by their consumers' boards.
 */

import { flatten } from "#decoder/serialize-tuples"
import type { AddressNode, AddressTree } from "#decoder/types"
import type { ComponentTag } from "#types/component"

/**
 * True when every node in the tree either carries `tag` or bears no value — i.e. the only EVIDENCE in the parse is
 * `tag`-shaped. A tag-matching node counts even when its value is empty (the guard asks "did the parser emit this
 * shape", not "is the span non-blank"); any OTHER tag with a non-empty value disqualifies. False for a tree with no
 * `tag` node at all.
 */
export function isBareTreeOf(tree: AddressTree, tag: ComponentTag): boolean {
	let sawTag = false
	const stack = [...tree.roots]

	while (stack.length) {
		const node = stack.pop()!

		if (node.tag === tag) {
			sawTag = true
		} else if (node.value.trim() !== "") return false

		stack.push(...node.children)
	}

	return sawTag
}

/**
 * The tree's single value-bearing node, or null when the tree holds none or more than one. Callers check on the
 * returned node's `tag` — the quantifier ("this is the WHOLE query") is what this walk answers.
 */
export function loneValueBearingNode(tree: AddressTree): AddressNode | null {
	let lone: AddressNode | null = null
	const stack = [...tree.roots]

	while (stack.length) {
		const node = stack.pop()!

		if (node.value.trim().length) {
			if (lone !== null) return null
			lone = node
		}

		stack.push(...node.children)
	}

	return lone
}

/**
 * One flattened node, projected for display.
 *
 * A structural copy rather than the `AddressNode` itself: a consumer rendering a span list must not be handed the live
 * node, whose `children` and `metadata` invite a walk it has already been given the result of.
 */
export interface FlatTreeNode {
	tag: ComponentTag
	value: string
	confidence: number
	start: number
	end: number
	/**
	 * Where the assertion came from — `rule`, `neural`, `resolver`.
	 *
	 * Carried because a span that keeps its tag, its text and its confidence while its source moves from `resolver` to
	 * `neural` has lost its gazetteer backing, and a projection that drops this reports that span as unchanged.
	 */
	source?: string
	sourceID?: string
	/**
	 * The resolver's answer for this span, when one won.
	 *
	 * Carried for the same reason `source` is: a projection that keeps only the text and the tag cannot tell a span that
	 * resolved to a DIFFERENT place from one that did not move at all, and those are a ranking problem and a non-event
	 * respectively. `alternatives` is reduced to its LENGTH — the retrieval breadth is what a consumer reads, and handing
	 * over the candidate objects invites a walk this projection exists to have already done.
	 */
	placeID?: string
	lat?: number
	lon?: number
	alternatives?: number
}

/**
 * Flatten a tree to its nodes in SOURCE order — sorted by `start`, the same order `decodeAsTuples` means by it.
 *
 * The two copies this replaces (the demo's `demo-helpers.ts` and the `demo-cascade-smoke` mirror of it) relied on
 * TRAVERSAL order instead: depth-first onto a stack, then reversed. That coincides with source order only while every
 * parent's span precedes its children's, and the decoder does not promise it — measured, the two orders disagree on **7
 * of 10** ordinary addresses, always with a child ahead of its parent:
 *
 *     Queen Street, Bristol              street_suffix@6 before street@0
 *     Via Roma, 5, 50123 Firenze, …      house_number@10 before street@0
 *     30 St Mary Axe …, London EC3A 8BF  postcode@37     before locality@30
 *
 * Sorting is what the tuple projection already does, so this makes a rendered span list and `decodeAsTuples` agree by
 * construction rather than by luck.
 *
 * The smoke test could not import the demo's copy (that would be a `mailwoman` → `docs` project reference, and `docs`
 * already depends on `mailwoman`), which is why a third home was the only way to collapse them.
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

/**
 * Every node of a forest in DOCUMENT order: parent before children, siblings by their position in the input.
 *
 * The order is material, not a convenience. `find` over this walk decides which of two same-tag spans becomes a named
 * result slot, and the flat component map (`decodeAsJSON`) keeps the first span in text order. A LIFO walk once yielded
 * siblings reversed, so `Village of Fae, Camino Real, …` answered `venue: "Camino Real"` in the named slot while the
 * component map said `Village of Fae`, and four board rows failed on the slot alone. One order, the text's, for both.
 */
export function* walkNodes(roots: readonly AddressNode[]): Generator<AddressNode> {
	const stack = roots.toReversed()

	while (stack.length) {
		const node = stack.pop()!

		yield node

		for (let index = node.children.length - 1; index >= 0; index--) {
			stack.push(node.children[index]!)
		}
	}
}

/**
 * Every node satisfying `predicate`, in {@link walkNodes} order.
 */
export function collectNodes(roots: readonly AddressNode[], predicate: (node: AddressNode) => boolean): AddressNode[] {
	const matches: AddressNode[] = []

	for (const node of walkNodes(roots)) {
		if (predicate(node)) {
			matches.push(node)
		}
	}

	return matches
}

/**
 * A node the resolver grounded: it carries a coordinate, a place identifier, or a resolution-tier stamp from the street
 * tiers. Grounding is what a result may CLAIM about a span; an ungrounded span is text the parser labeled and nothing
 * more.
 */
export function isGroundedNode(node: AddressNode): boolean {
	return (
		(node.lat != null && node.lon != null) ||
		node.placeID !== undefined ||
		node.metadata?.["resolution_tier"] !== undefined
	)
}

/**
 * The order in which a projection reads spans when one tag occurs twice: every grounded node first, then the rest, each
 * group in document order. Both the flat component map (`decodeAsJSON`) and the named result slots read THIS order, so
 * they name the same span.
 *
 * The rule is the one a gazetteer-backed geocoder applies by construction: a component is what RESOLVED, and the
 * query's wording only decides among spans nothing resolved. `12 MG Road, Indiranagar, Bengaluru, Karnataka 560038,
 * India` parses two `locality` spans; `Bengaluru` resolves and `Karnataka` does not (it is a region), so the locality
 * is Bengaluru. `Village of Fae, Camino Real, Carmel-By-The-Sea, CA 93921` parses two `venue` spans and grounds
 * neither, so the first in the text is the venue. Before resolution runs, nothing is grounded and the order is the
 * text's.
 */
export function slotNodes(roots: readonly AddressNode[]): AddressNode[] {
	const inDocumentOrder = [...walkNodes(roots)]

	return inDocumentOrder.toSorted((a, b) => Number(isGroundedNode(b)) - Number(isGroundedNode(a)))
}

/**
 * The first node satisfying `predicate`, or undefined.
 */
export function firstNodeWhere(
	roots: readonly AddressNode[],
	predicate: (node: AddressNode) => boolean
): AddressNode | undefined {
	for (const node of walkNodes(roots)) {
		if (predicate(node)) return node
	}

	return undefined
}
