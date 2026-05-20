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
 *   - `src` — provenance for the assertion. Formatted as `<source>:<sourceId>` when both fields are
 *       present on the node, `<source>` when only the broad category is set, omitted when neither
 *       is. Phase 4.1 surfaces classifier provenance (`rule:whos_on_first`, `neural:v0.3.1-en-us`);
 *       Phase 4.3 overlays resolver provenance (`resolver:wof-admin:101751119`).
 *   - `lat` / `lon` — resolver-supplied centroid (Phase 4.3). Emitted only when both are set.
 *   - `place` — resolver-supplied normalized place URI like `wof:101751119` (Phase 4.3). Emitted only
 *       when `node.placeId` is set; distinct from `src` so callers that want the bare place id
 *       without the vendor prefix have a direct attribute to read.
 *   - Root `<address>` carries `raw` — the full input string for round-trip.
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
	/** Include `src` provenance attribute when the node carries source info. Default true. */
	includeSrc?: boolean
	/** Include `lat` + `lon` resolver-supplied centroid attrs when set on the node. Default true. */
	includeGeo?: boolean
	/** Include `place` resolver-supplied normalized place URI when set. Default true. */
	includePlace?: boolean
}

function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function srcAttrValue(node: AddressNode): string | null {
	if (node.source && node.sourceId) return `${node.source}:${node.sourceId}`
	if (node.source) return node.source
	if (node.sourceId) return node.sourceId
	return null
}

/**
 * Centroid precision for resolver-supplied lat/lon. 6 decimal places is ~11 cm at the equator —
 * more than enough for any postal-address resolver and short enough to stay readable.
 */
const GEO_PRECISION = 6

function attrs(node: AddressNode, opts: Required<SerializeXmlOpts>): string {
	const parts: string[] = []
	if (opts.includeOffsets) parts.push(`start="${node.start}"`, `end="${node.end}"`)
	if (opts.includeConf) parts.push(`conf="${node.confidence.toFixed(2)}"`)
	if (opts.includeSrc) {
		const src = srcAttrValue(node)
		if (src !== null) parts.push(`src="${escapeXml(src)}"`)
	}
	// Emit lat + lon together — a centroid is meaningless with only one coordinate. Resolvers that
	// can produce one but not the other shouldn't decorate the node at all.
	if (opts.includeGeo && node.lat !== undefined && node.lon !== undefined) {
		parts.push(`lat="${node.lat.toFixed(GEO_PRECISION)}"`, `lon="${node.lon.toFixed(GEO_PRECISION)}"`)
	}
	if (opts.includePlace && node.placeId !== undefined) {
		parts.push(`place="${escapeXml(node.placeId)}"`)
	}
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
		includeSrc: opts.includeSrc ?? true,
		includeGeo: opts.includeGeo ?? true,
		includePlace: opts.includePlace ?? true,
	}
	const rawAttr = escapeXml(tree.raw)
	const nl = full.pretty ? "\n" : ""
	const indent = full.pretty ? "\t" : ""
	const children = tree.roots.map((r) => serializeNode(r, indent, full)).join(nl)
	return `<address raw="${rawAttr}">${nl}${children}${nl}</address>`
}
