/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Libpostal-compatible JSON projection.
 *
 *   Flattens the tree to `{ tag: value }`. First-occurrence wins for repeated tags — matches
 *   libpostal's behavior. Use `decodeAsTuples` if order or repetition matters.
 */

import type { ComponentTag } from "../types/component.js"
import type { AddressNode, AddressTree } from "./types.js"

function visit(node: AddressNode, out: Partial<Record<ComponentTag, string>>): void {
	if (!(node.tag in out)) out[node.tag] = node.value
	for (const child of node.children) visit(child, out)
}

/** Project an `AddressTree` to a flat libpostal-style component map. */
export function decodeAsJson(tree: AddressTree): Partial<Record<ComponentTag, string>> {
	const out: Partial<Record<ComponentTag, string>> = {}
	for (const root of tree.roots) visit(root, out)
	return out
}
