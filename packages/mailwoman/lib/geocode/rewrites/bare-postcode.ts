// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The bare-postcode rewrite: a tree whose one value is an unambiguous postcode gets that value tagged `postcode`.
 */

import { type AddressNode, type AddressTree, walkNodes } from "@mailwoman/core/decoder"
import { countryFromPostcodeFormat } from "@mailwoman/postcode/postcode-format"

/**
 * Retags the tree's only valued node as `postcode` when its value is an unambiguous postcode.
 *
 * The model sometimes tags a bare postcode such as `N7 0BT` as a street.
 * The resolver then finds no coordinate.
 * The retag applies only when all of these hold:
 *
 * - The tree has no `postcode` node.
 * - The node is the only node with a value.
 * - `countryFromPostcodeFormat` maps the value to a single country, as it does for GB, CA and IE formats.
 *
 * The function mutates the tree and returns it.
 */
export function recognizeBarePostcode(tree: AddressTree): AddressTree {
	const valued: AddressNode[] = []

	for (const n of walkNodes(tree.roots)) {
		if (n.tag === "postcode") return tree

		if (n.value.trim()) {
			valued.push(n)
		}
	}

	if (valued.length !== 1) return tree
	const only = valued[0]!

	if (!countryFromPostcodeFormat(only.value)) return tree
	only.tag = "postcode"

	only.metadata = { ...only.metadata, bare_postcode_retag: true }

	return tree
}
