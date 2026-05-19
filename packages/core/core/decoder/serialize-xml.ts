/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   XML projection — nested mixed-content with attributes.
 *
 *   Each component is one element. The element's _direct text node_ is the component's own value
 *   (e.g. `<locality>Paris…</locality>` — "Paris" is the locality's text). Children are nested as
 *   sub-elements representing geographic / structural containment.
 *
 *   Attributes:
 *
 *   - `conf` — aggregated confidence in [0, 1], two decimal places.
 *   - `start` / `end` — character offsets in the raw input. Preserves source order alongside the
 *       containment-derived element order.
 *   - Root `<address>` carries `raw` — the full input string for round-trip.
 *   - `src` is reserved for Phase 4 (Resolver source provenance) and not emitted here.
 *
 *   ⚠ DOM gotcha: `element.textContent` on a mixed-content node returns the concatenation of all
 *   descendant text (parent value + children values). Use `Array.from(el.childNodes).filter(n =>
 *   n.nodeType === 3).map(n => n.nodeValue).join('').trim()` or XPath `text()` to get just the
 *   parent's own value. Documented in the package README.
 */

import type { AddressNode, AddressTree } from "./types.js"

export interface SerializeXmlOpts {
	/** Pretty-print with line breaks and indentation. Default true. */
	pretty?: boolean
	/** Include `conf` attribute on every component. Default true. */
	includeConf?: boolean
	/** Include `start` + `end` char-offset attributes. Default true. */
	includeOffsets?: boolean
}

function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function attrs(node: AddressNode, opts: Required<SerializeXmlOpts>): string {
	const parts: string[] = []
	if (opts.includeOffsets) parts.push(`start="${node.start}"`, `end="${node.end}"`)
	if (opts.includeConf) parts.push(`conf="${node.confidence.toFixed(2)}"`)
	return parts.length === 0 ? "" : " " + parts.join(" ")
}

function serializeNode(node: AddressNode, indent: string, opts: Required<SerializeXmlOpts>): string {
	const a = attrs(node, opts)
	const text = escapeXml(node.value)
	const nl = opts.pretty ? "\n" : ""
	const childIndent = opts.pretty ? indent + "\t" : ""

	if (node.children.length === 0) {
		return `${indent}<${node.tag}${a}>${text}</${node.tag}>`
	}

	const children = node.children.map((c) => serializeNode(c, childIndent, opts)).join(nl)
	return `${indent}<${node.tag}${a}>${text}${nl}${children}${nl}${indent}</${node.tag}>`
}

/** Project an `AddressTree` to nested XML with optional confidence/offset attributes. */
export function decodeAsXml(tree: AddressTree, opts: SerializeXmlOpts = {}): string {
	const full: Required<SerializeXmlOpts> = {
		pretty: opts.pretty ?? true,
		includeConf: opts.includeConf ?? true,
		includeOffsets: opts.includeOffsets ?? true,
	}
	const rawAttr = escapeXml(tree.raw)
	const nl = full.pretty ? "\n" : ""
	const indent = full.pretty ? "\t" : ""
	const children = tree.roots.map((r) => serializeNode(r, indent, full)).join(nl)
	return `<address raw="${rawAttr}">${nl}${children}${nl}</address>`
}
