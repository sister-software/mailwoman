// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Depth-first flatten of a decoded parse tree for span-based grading.
 */

import { walkNodes } from "@mailwoman/core/decoder"

/**
 * Minimal node shape used by grading boards.
 *
 * This is intentionally looser than `AddressNode` and keeps only the fields
 * needed for span grading plus recursion.
 */
export interface FlatNode {
	tag: string
	value: string
	start: number
	confidence?: number
	children?: readonly FlatNode[]
}

/**
 * Returns every node in depth-first order (parents before children).
 */
export function flattenNodes(nodes: readonly FlatNode[]): FlatNode[] {
	const out: FlatNode[] = [...walkNodes(nodes)]

	return out
}
