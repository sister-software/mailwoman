/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file This module defines the tree walk and slot order used by result projections.
 *   It stays a leaf module because `serialize-json`, `serialize-tuples`, `unknown-spans`, and `tree-shape` all read it.
 *   The walk would create a cycle through `serialize-tuples` if it sat beside `tree-shape`'s reporters.
 */

import type { AddressNode } from "#decoder/types"

/**
 * Every node of a forest in document order: parent before children, siblings by their position in the input.
 *
 * The function accepts any node shape that has `children`.
 * The eval harness's flat nodes and admin-coherence tree use it like decoder nodes do.
 *
 * The order determines which of two same-tag spans becomes a result slot when `find` walks the nodes.
 * The flat component map (`decodeAsJSON`) keeps the first span in text order.
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
export function collectNodes(roots: readonly AddressNode[], predicate: (node: AddressNode) => unknown): AddressNode[] {
	const matches: AddressNode[] = []

	for (const node of walkNodes(roots)) {
		if (predicate(node)) {
			matches.push(node)
		}
	}

	return matches
}

/**
 * A node the resolver grounded: it has a coordinate, a place identifier,
 * or a resolution-tier stamp from the street tiers.
 *
 * A result may claim only the information grounded in a span.
 * An ungrounded span is text the parser labeled and no more.
 */
export function isGroundedNode(node: AddressNode): boolean {
	return (
		(node.lat != null && node.lon != null) ||
		node.placeID !== undefined ||
		node.metadata?.["resolution_tier"] !== undefined
	)
}

/**
 * The order in which a projection reads spans when one tag occurs twice:
 * every grounded node first, then the rest, each group in document order.
 *
 * The flat component map (`decodeAsJSON`) and result slots read this order.
 * They expose the same span: a component is what resolved.
 *
 * Query wording only decides among ungrounded spans.
 * Before resolution runs the order is the text's and no node is grounded.
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
	predicate: (node: AddressNode) => unknown
): AddressNode | undefined {
	return walkNodes(roots).find(predicate)
}
