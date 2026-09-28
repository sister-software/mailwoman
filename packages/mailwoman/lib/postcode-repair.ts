/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The postcode-contradiction repair rung, firing only on a high-confidence letter-digit postcode shape whose span carries no postcode node and whose every node is a wholly-contained street/house-number-family misread.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { collectNodes, firstNodeWhere, walkNodes } from "@mailwoman/core/decoder"
import type { QueryShape } from "@mailwoman/query-shape"

/**
 * Postcode formats whose surface is structurally distinguishable from anything else an address writes, excluding five-digit families whose digits can be house numbers and `nl_postcode` whose shape can be a house number plus a directional.
 */
const REPAIRABLE_POSTCODE_FORMATS: ReadonlySet<string> = new Set(["uk_postcode", "ca_postcode"])

const MIN_FORMAT_CONFIDENCE = 0.9

/**
 * The tags the misread produces; any other tag overlapping the format span vetoes the repair, because the rung replaces a wrong reading and never a plausible one.
 */
const MISREAD_TAGS: ReadonlySet<string> = new Set([
	"street",
	"house_number",
	"street_suffix",
	"street_prefix",
	"unit",
	// A real PO Box surface can never match a letter-digit postcode format span, so replacing a `po_box` reading such as `PO33 4DE` is safe.
	"po_box",
])

function overlaps(node: AddressNode, start: number, end: number): boolean {
	return node.start < end && node.end > start
}

function within(node: AddressNode, start: number, end: number): boolean {
	return node.start >= start && node.end <= end
}

/**
 * Repairs the tree in place when a high-confidence letter-digit postcode span carries no postcode node and every node inside it is a street/house-number-family misread; a span that already carries a postcode node never repairs, so the alternate-register retry cannot double-fire.
 *
 * @returns `true` when a repair was applied.
 */
export function repairPostcodeContradiction(tree: AddressTree, shape: QueryShape): boolean {
	let repaired = false

	for (const hit of shape.knownFormats) {
		if (!REPAIRABLE_POSTCODE_FORMATS.has(hit.format) || hit.confidence < MIN_FORMAT_CONFIDENCE) continue

		const { start, end, body } = hit.span

		if (anyNode(tree, (n) => n.tag === "postcode" && overlaps(n, start, end))) continue

		const touching = collectNodes(tree.roots, (n) => overlaps(n, start, end))

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
	return firstNodeWhere(tree.roots, predicate) !== undefined
}

function removeNodes(tree: AddressTree, doomed: ReadonlySet<AddressNode>): void {
	tree.roots = tree.roots.filter((n) => !doomed.has(n))

	for (const node of walkNodes(tree.roots)) {
		node.children = node.children.filter((n) => !doomed.has(n))
	}
}
