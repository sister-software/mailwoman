/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Depth-first flatten of a decoded parse tree, for the boards that grade spans rather than a resolved answer.
 */

import { walkNodes } from "@mailwoman/core/decoder"

/**
 * The node shape the boards walk.
 *
 * Deliberately looser than `AddressNode`: a board reads a tree back out of a decoder result, so it needs the three
 * fields it grades on and the recursion, not the full contract. Naming the recursion is what keeps the walk cast-free —
 * a `children?: unknown` forces every push through an assertion, and the assertion is where a wrong shape stops being a
 * type error.
 */
export interface FlatNode {
	tag: string
	value: string
	start: number
	children?: readonly FlatNode[]
}

/**
 * Every node in the tree, parents before children.
 */
export function flattenNodes(nodes: readonly FlatNode[]): FlatNode[] {
	const out: FlatNode[] = [...walkNodes(nodes)]

	return out
}
