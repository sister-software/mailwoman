// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Stamp each parsed span with the ISO 15924 script it is written in.
 *
 *   This lives in `mailwoman` rather than in either package it draws on, because neither may reach the
 *   other: `@mailwoman/recognizer` owns `scriptForRange` and may not import `@mailwoman/core`'s
 *   tree, and `@mailwoman/core` owns `AddressTree` and may not depend on `recognizer`.
 *
 *   The entry package depends on both, so the join happens once, here,
 *   rather than as a re-typed fold on either side.
 */

import { walkNodes, type AddressTree } from "@mailwoman/core/decoder"
import { computeQueryShape } from "@mailwoman/postcode/recognizer/query-shape"
import { QueryShapeGeneration } from "@mailwoman/postcode/recognizer/rule-generation"
import { scriptForRange } from "@mailwoman/recognizer/charset"
import { rangeScript } from "@mailwoman/recognizer/script-run"

/**
 * Write `script` onto every node of `tree`, in place.
 *
 * `text` must be the string the node offsets index into.
 * The normalized input rather than the raw one, since that's what the classifier labeled.
 *
 * The raw string would silently mis-range every span on any input normalization touched.
 *
 * The tokens are classified here rather than read off the pipeline's `QueryShapeLite`,
 * whose per-token `script` is optional and typed as a plain string: narrowing that back
 * to the registry's script code would be a cast asserting what this call can compute.
 * It is one engine call over an address-length string, next to a model inference.
 */
export function stampSpanScripts(
	tree: AddressTree,
	text: string,
	generation: QueryShapeGeneration = QueryShapeGeneration.Legacy
): void {
	const { tokenClasses } = computeQueryShape(text, generation)

	const scriptOfSpan = generation === QueryShapeGeneration.Postal ? rangeScript : scriptForRange

	for (const node of walkNodes(tree.roots)) {
		node.script = scriptOfSpan(tokenClasses, node.start, node.end)
	}
}
