// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file An indented text outline of a parse tree, one node per line.
 */

import type { AddressNode, AddressTree } from "#decoder/types"
import { stringifyJSON } from "#json"

function outlineLines(node: AddressNode, depth: number, lines: string[]): void {
	lines.push(`${"  ".repeat(depth)}${node.tag} [${node.start}, ${node.end}): ${stringifyJSON(node.value)}`)

	for (const child of node.children) {
		outlineLines(child, depth + 1, lines)
	}
}

/**
 * Returns the tree as text, one node per line, each child indented two spaces under its parent.
 *
 * A line reads `tag [start, end): "value"`, where the span indexes `tree.raw`:
 *
 * ```text
 * region [28, 30): "NY"
 *   locality [19, 27): "New York"
 * ```
 */
export function decodeAsOutline(tree: AddressTree): string {
	const lines: string[] = []

	for (const root of tree.roots) {
		outlineLines(root, 0, lines)
	}

	return lines.join("\n")
}
