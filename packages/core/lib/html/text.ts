/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reading an HTML fragment as text, on `htmlparser2` — one rule, read two ways.
 *
 *   `stripHTMLToText` (`@mailwoman/core/trust-policies`) answers almost all of this already, and
 *   correctly: it decodes entities, survives a `<` inside an attribute value, and leaves source
 *   whitespace runs intact. What it cannot do is the ONE rule here — `textContent` inserts nothing at an
 *   element boundary, so `<td>a</td><td>b</td>` reads as `"ab"` and `<p>Acme Fiber</p><p>LLC</p>` as
 *   `"Acme FiberLLC"`, a name that appears nowhere in the document. Reach for the sanitizer from a module
 *   that already sanitizes; its Node build constructs a jsdom window at import (measured 422 ms, 71 MB,
 *   against `htmlparser2`'s 12 ms), which is priced for sanitizing, not for reading a table.
 */

import { Parser } from "htmlparser2"

import { normalizeWhitespace } from "#strings/format"

/**
 * Elements whose text content is code or styling, never prose.
 */
const NON_PROSE_ELEMENTS = new Set(["script", "style", "template"])

/**
 * Element names whose boundaries end a LINE rather than separating two words — pass to {@linkcode htmlToLayoutText} when
 * reading one logical entry per line. A minified document with no literal newline anywhere in it still separates one
 * entry per line this way.
 */
export const BLOCK_ELEMENTS: ReadonlySet<string> = new Set([
	"address",
	"article",
	"blockquote",
	"body",
	"br",
	"div",
	"footer",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"head",
	"header",
	"hr",
	"html",
	"li",
	"ol",
	"p",
	"pre",
	"section",
	"table",
	"tbody",
	"td",
	"tfoot",
	"th",
	"thead",
	"title",
	"tr",
	"ul",
])

/**
 * The text of an HTML fragment with SOURCE WHITESPACE RUNS INTACT — the reading for a document that states its columns
 * as runs of spaces. Entities are decoded, and every whitespace character the document states survives as itself: a
 * caller splitting on a run must include U+00A0 in its own character class, since `&nbsp;` and `&#160;` are the same
 * character and `[ \t]` matches neither.
 *
 * Markup between two text runs inserts ONE separator, and only where the source states none — so `<td>a</td><td>b</td>`
 * separates into two values while `a <b>b</b>` stays single-spaced, and neither fabricates the 2+-space run a caller
 * would read as a column boundary. A run of markup is one separation, not one per tag: `</p><p>` inserts a single
 * break. An element in `lineBreakElements` makes that separator a newline, unconditionally — a line boundary the
 * document states is not a spacing judgment.
 */
export function htmlToLayoutText(html: string, lineBreakElements?: ReadonlySet<string>): string {
	let text = ""
	let nonProseDepth = 0
	let pending: "" | " " | "\n" = ""

	const onTag = (name: string, delta: 1 | -1): void => {
		if (NON_PROSE_ELEMENTS.has(name) && (delta === 1 || nonProseDepth > 0)) {
			nonProseDepth += delta
		}

		pending = lineBreakElements?.has(name) || pending === "\n" ? "\n" : " "
	}

	const parser = new Parser(
		{
			onopentag: (name) => onTag(name, 1),
			onclosetag: (name) => onTag(name, -1),
			oncomment: () => (pending ||= " "),
			ontext(chunk) {
				if (nonProseDepth > 0) return

				if (pending === "\n") {
					text += "\n"
				} else if (pending === " " && text !== "" && !/\s$/u.test(text) && !/^\s/u.test(chunk)) {
					text += " "
				}

				pending = ""
				text += chunk
			},
		},
		{ decodeEntities: true }
	)

	parser.write(html)
	parser.end()

	return text
}

/**
 * The prose text of an HTML fragment: the same reading, whitespace collapsed to single spaces and trimmed. This is the
 * reading for a value compared or stored as text — one table cell, a service `licenseInfo` block, a tile attribution.
 */
export function htmlToText(html: string): string {
	return normalizeWhitespace(htmlToLayoutText(html))
}
