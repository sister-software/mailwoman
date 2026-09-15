/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Stamp each parsed span with the ISO 15924 script it is written in (#2282).
 *
 *   This lives in `mailwoman` rather than in either package it draws on, because neither may reach the other:
 *   `@mailwoman/query-shape` owns `scriptForRange` and carries no `@mailwoman/*` dependency at all, and
 *   `@mailwoman/core` owns `AddressTree` and may not depend on query-shape. The entry package depends on both, so the
 *   join happens once, here, rather than as a re-typed fold on either side.
 */

import { walkNodes, type AddressTree } from "@mailwoman/core/decoder"
import { classifyTokens, scriptForRange } from "@mailwoman/query-shape"

/**
 * Write `script` onto every node of `tree`, in place.
 *
 * `text` must be the string the node offsets index into — the NORMALIZED input, not the raw one, since that is what the
 * classifier labelled. Passing the raw string would silently mis-range every span on any input normalization touched.
 *
 * The tokens are classified here rather than read off the pipeline's `QueryShapeLite`, whose per-token `script` is
 * optional and typed as a plain string: narrowing that back to `ScriptCode` would be a cast asserting what this call
 * can simply compute. It is one codepoint scan of an address-length string, next to a model inference.
 */
export function stampSpanScripts(tree: AddressTree, text: string): void {
	const tokens = classifyTokens(text)

	for (const node of walkNodes(tree.roots)) {
		node.script = scriptForRange(tokens, node.start, node.end)
	}
}
