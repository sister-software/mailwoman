/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file This module defines the tree walk and slot order used by result projections.
 *   It stays a leaf module because `serialize-json`, `serialize-tuples`, `unknown-spans`, and `tree-shape` all read it.
 *   The walk would create a cycle through `serialize-tuples` if it sat beside `tree-shape`'s reporters.
 */

import { isAdminHierarchyTag } from "@mailwoman/codex/component"

import type { AddressNode } from "#decoder/types"

/**
 * Every node of a forest in document order: parent before children, siblings by their position in the input.
 *
 * The function accepts any node shape that has `children`.
 * The eval harness's flat nodes and admin-coherence tree use it like decoder nodes do.
 *
 * This is the input's own order. {@link slotNodes} re-orders it for the projections.
 * Those projections choose among same-tag spans by grounding and confidence rather than by position.
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
 * The order in which a projection reads spans when one tag occurs twice.
 *
 * Four per-node keys decide it, in this order:
 *
 * 1. A grounded node precedes an ungrounded one, because a component is what resolved.
 * 2. A node whose tag satisfies {@linkcode isAdminHierarchyTag} precedes one whose tag does not.
 * 3. Among the nodes outside that set, the higher label confidence precedes the lower.
 * 4. Document order breaks the remaining ties.
 *    `toSorted` preserves it.
 *
 * Confidence decides outside the hierarchy set because a span's position states no
 * evidence about which of two same-tag spans is the component.
 * A line that opens with a venue name the model labeled `street` puts that span first
 * in the text while the model scores it below the street that follows.
 *
 * Inside the hierarchy set the canonical line runs finest to coarsest,
 * so position is the evidence and confidence is not: a coarser place name is more
 * frequent in training and scores higher for that reason.
 *
 * A merged span takes the minimum of its token confidences (`span/bridge.ts`).
 * A long span is therefore ordered by its weakest token rather than by its mean.
 *
 * Key 2 also moves hierarchy nodes ahead of other tags.
 * Every consumer reads this list one tag at a time (`decodeAsJSON` keys the flat
 * map by tag; `extractGeocodeResult` and `plus-code-override` search it by tag),
 * so the order between two different tags is not part of the interface.
 */
export function slotNodes(roots: readonly AddressNode[]): AddressNode[] {
	const inDocumentOrder = [...walkNodes(roots)]

	return inDocumentOrder.toSorted((a, b) => {
		const grounding = Number(isGroundedNode(b)) - Number(isGroundedNode(a))

		if (grounding !== 0) return grounding

		const aHierarchy = isAdminHierarchyTag(a.tag)
		const bHierarchy = isAdminHierarchyTag(b.tag)

		if (aHierarchy !== bHierarchy) return Number(bHierarchy) - Number(aHierarchy)

		if (aHierarchy) return 0

		return b.confidence - a.confidence
	})
}

/**
 * The first node satisfying `predicate`, or undefined.
 */
export function firstNodeWhere(
	roots: readonly AddressNode[],
	predicate: (node: AddressNode) => unknown
): AddressNode | null {
	return walkNodes(roots).find(predicate) ?? null
}
