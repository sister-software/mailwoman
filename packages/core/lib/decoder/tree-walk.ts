/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The one tree walk, in document order, and the slot order both result projections read. A leaf module on
 *   purpose: `serialize-json`, `serialize-tuples`, `unknown-spans` and `tree-shape` all read it, and a walk that lived
 *   beside `tree-shape`'s reporters closed a cycle through `serialize-tuples` (#2163).
 */

import type { AddressNode } from "#decoder/types"

/**
 * Every node of a forest in DOCUMENT order: parent before children, siblings by their position in the input. Generic
 * over any node shape carrying `children`, so the eval harness's flat nodes and the admin-coherence tree walk the same
 * way the decoder's do — the one implementation the #2163 sweep replaced every hand-rolled LIFO walk with.
 *
 * The order is material, not a convenience. `find` over this walk decides which of two same-tag spans becomes a named
 * result slot, and the flat component map (`decodeAsJSON`) keeps the first span in text order. A LIFO walk once yielded
 * siblings reversed, so `Village of Fae, Camino Real, …` answered `venue: "Camino Real"` in the named slot while the
 * component map said `Village of Fae`, and four board rows failed on the slot alone. One order, the text's, for both.
 */
export function* walkNodes<T extends { children?: readonly T[] }>(roots: readonly T[]): Generator<T> {
	const stack = roots.toReversed()

	while (stack.length) {
		const node = stack.pop()!

		yield node

		const children = node.children ?? []

		for (let index = children.length - 1; index >= 0; index--) {
			stack.push(children[index]!)
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
