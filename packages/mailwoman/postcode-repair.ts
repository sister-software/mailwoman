/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #1735 — the postcode-contradiction repair rung.
 *
 *   The contradiction it consumes was recorded before it was fixed: `KT2 6AB` under the en-US default decoded as
 *   `{street: "KT2", house_number: "6AB"}` while the query-shape stage held `uk_postcode` at 0.9 over the exact span —
 *   three stages holding the correct hypothesis and the tree holding the wrong one. Measured on the GB Code-Point
 *   eval: 11 of 600 stratified postcodes under the production default (3 bare-form misses, 8 country-suffixed rows
 *   answering the country label centroid, 27–221 km off); 0 of 600 under `--locale en-GB`.
 *
 *   The rung fires ONLY on that contradiction, and only for postcode formats whose SHAPE is structurally
 *   letter-digit ({@link REPAIRABLE_POSTCODE_FORMATS}): a `SW1A 1AA` cannot be a house number. The five-digit
 *   families (us_zip / fr / de) are deliberately excluded — `12345` in `12345 Main St` is a house number, and a
 *   repair that could eat it would trade a GB fix for a US regression. Positive evidence only: the rung ADDS a
 *   postcode node derived from the shape span and removes only the street/house-number-family nodes that sat wholly
 *   inside that span; any node extending beyond the span vetoes the repair.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import type { QueryShape } from "@mailwoman/query-shape"

/**
 * Postcode formats whose surface is structurally distinguishable from anything else an address writes — letters mixed
 * INTO the digit groups (GB `KT2 6AB`, CA `M5H 2N2`). Membership is earned by that structural argument, never by
 * coverage ambition. Two exclusions, both measured rather than reasoned:
 *
 * - Five-digit families (us_zip / fr / de): `12345` in `12345 Main St` is a house number.
 * - `nl_postcode` (`\d{4} [A-Z]{2}`): **"3215 SE" in "3215 SE Clinton St" matches it** — a US house number plus a
 *   directional. The session-trace invariance test caught the first draft of this set eating exactly that span.
 */
export const REPAIRABLE_POSTCODE_FORMATS: ReadonlySet<string> = new Set(["uk_postcode", "ca_postcode"])

/**
 * Minimum shape-stage confidence for the format hit before the rung may fire.
 */
const MIN_FORMAT_CONFIDENCE = 0.9

/**
 * The tags the misread produces. A node with any OTHER tag overlapping the format span vetoes the repair — the rung
 * replaces a wrong reading, never a plausible one.
 */
const MISREAD_TAGS: ReadonlySet<string> = new Set([
	"street",
	"house_number",
	"street_suffix",
	"street_prefix",
	"unit",
	// "PO33 4DE" — the Portsmouth/Isle of Wight area reads as a PO Box. A REAL PO Box surface ("PO Box
	// 123") can never match a letter-digit postcode format span, so the format gate keeps this safe.
	"po_box",
])

function overlaps(node: AddressNode, start: number, end: number): boolean {
	return node.start < end && node.end > start
}

function within(node: AddressNode, start: number, end: number): boolean {
	return node.start >= start && node.end <= end
}

/**
 * Repair the tree IN PLACE when a high-confidence letter-digit postcode span carries no postcode node and every node
 * inside it is a street/house-number-family misread. Returns `true` when a repair was applied. Idempotent: a tree that
 * already carries a postcode node over the span never repairs, so the alternate-register retry path cannot
 * double-fire.
 */
export function repairPostcodeContradiction(tree: AddressTree, shape: QueryShape): boolean {
	let repaired = false

	for (const hit of shape.knownFormats) {
		if (!REPAIRABLE_POSTCODE_FORMATS.has(hit.format) || hit.confidence < MIN_FORMAT_CONFIDENCE) continue

		const { start, end, body } = hit.span

		// Gate 1: the span already resolved to a postcode node somewhere — nothing to repair.
		if (anyNode(tree, (n) => n.tag === "postcode" && overlaps(n, start, end))) continue

		// Gate 2: every value-bearing node touching the span is a misread-family node sitting WHOLLY
		// inside it. A node of any other tag, or one extending beyond the span, vetoes the repair.
		const touching = collectNodes(tree, (n) => overlaps(n, start, end))

		if (!touching.length) continue

		if (!touching.every((n) => MISREAD_TAGS.has(n.tag) && within(n, start, end))) continue

		removeNodes(tree, new Set(touching))

		tree.roots.push({
			tag: "postcode",
			value: body,
			start,
			end,
			confidence: hit.confidence,
			children: [],
			metadata: { repaired: "postcode_shape_contradiction" },
		})

		repaired = true
	}

	return repaired
}

function anyNode(tree: AddressTree, predicate: (node: AddressNode) => boolean): boolean {
	return collectNodes(tree, predicate).length > 0
}

function collectNodes(tree: AddressTree, predicate: (node: AddressNode) => boolean): AddressNode[] {
	const out: AddressNode[] = []
	const stack: AddressNode[] = [...tree.roots]

	while (stack.length) {
		const node = stack.pop()!

		if (predicate(node)) {
			out.push(node)
		}

		stack.push(...node.children)
	}

	return out
}

function removeNodes(tree: AddressTree, doomed: ReadonlySet<AddressNode>): void {
	tree.roots = tree.roots.filter((n) => !doomed.has(n))

	const stack: AddressNode[] = [...tree.roots]

	while (stack.length) {
		const node = stack.pop()!

		node.children = node.children.filter((n) => !doomed.has(n))
		stack.push(...node.children)
	}
}
