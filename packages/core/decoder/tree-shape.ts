/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tree-SHAPE predicates over an `AddressTree` — the one stack walk behind the pipeline's bare-tree
 *   guards and the "lone bare toponym" gates. Two quantifiers cover every consumer:
 *
 *   - {@link isBareTreeOf} — every value-bearing node carries the given tag (several allowed). The
 *     #912 / #1589 posture guards (`isBareLocalityTree`, `isBarePostcodeTree`) are this with the tag
 *     bound.
 *   - {@link loneValueBearingNode} — the tree has EXACTLY one value-bearing node. The street-miss
 *     fallback and the resolver's bare-country race bind the tag at the call site.
 *
 *   The distinction is load-bearing: a two-segment parse can satisfy the first and never the second,
 *   and both behaviors are pinned by their consumers' boards.
 */

import type { ComponentTag } from "../types/component.ts"
import type { AddressNode, AddressTree } from "./types.ts"

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
 * The tree's single value-bearing node, or null when the tree holds none or more than one. Callers gate on the returned
 * node's `tag` — the quantifier ("this is the WHOLE query") is what this walk answers.
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
