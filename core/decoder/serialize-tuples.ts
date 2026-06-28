/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Order-preserving tuple projection.
 *
 *   Emits `Array<[tag, value]>` in source order (sorted by `start`). Preserves repeated tags (e.g.
 *   two `locality` entries for "Springfield, IL — sent from Springfield, MA"). Hierarchy is lost —
 *   use `decodeAsXml` when containment matters.
 */

import type { ComponentTag } from "../types/component.js"
import type { AddressNode, AddressTree } from "./types.js"

function flatten(node: AddressNode, out: AddressNode[]): void {
	out.push(node)

	for (const child of node.children) flatten(child, out)
}

/** Project an `AddressTree` to a source-ordered list of (tag, value) pairs. */
export function decodeAsTuples(tree: AddressTree): Array<[ComponentTag, string]> {
	const all: AddressNode[] = []

	for (const root of tree.roots) flatten(root, all)
	all.sort((a, b) => a.start - b.start)

	return all.map((n) => [n.tag, n.value])
}
