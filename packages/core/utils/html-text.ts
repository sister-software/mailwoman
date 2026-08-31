/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Plain-text extraction from an HTML fragment, for metadata fields that arrive as markup — service
 *   `licenseInfo`/`description` blocks, tile attributions, and anything else an authority publishes
 *   as HTML that this system stores or compares as text.
 *
 *   Parsing is `htmlparser2`'s event parser, never a hand-rolled scan: a depth counter or a
 *   `/<[^>]*>/` regex misreads `<` inside attribute values, comments, CDATA, and unclosed tags — and
 *   a partial reading of a network-supplied field is indistinguishable from the field saying less
 *   than it does. Entity decoding is the parser's own, covering the full named set rather than a
 *   local table.
 */

import { Parser } from "htmlparser2"

/**
 * Elements whose text content is code or styling, never prose — excluded from extraction.
 */
const NON_PROSE_ELEMENTS = new Set(["script", "style", "template"])

/**
 * Extract the prose text of an HTML fragment: tags removed, entities decoded, whitespace collapsed to single spaces,
 * trimmed. Plain text passes through unchanged apart from whitespace collapse.
 *
 * `stripHTMLToText` (`@mailwoman/core/trust-policies`) answers the same question through the sanitizer engine, whose
 * Node build constructs a jsdom window at import. This one stays on the event parser so the `core/utils` barrel — and
 * every CLI that imports it — never pays that; reach for the sanitizer only from a module that already sanitizes.
 */
export function htmlToText(html: string): string {
	let text = ""
	let nonProseDepth = 0

	const parser = new Parser(
		{
			onopentag(name) {
				if (NON_PROSE_ELEMENTS.has(name)) {
					nonProseDepth++
				}
			},
			onclosetag(name) {
				if (NON_PROSE_ELEMENTS.has(name) && nonProseDepth > 0) {
					nonProseDepth--
				}
			},
			ontext(chunk) {
				if (nonProseDepth === 0) {
					text += chunk
				}
			},
		},
		{ decodeEntities: true }
	)

	parser.write(html)
	parser.end()

	return text.replaceAll(/\s+/gu, " ").trim()
}
