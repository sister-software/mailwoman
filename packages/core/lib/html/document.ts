/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Narrowing a document to the markup worth reading, before anything reads it. An archive document
 *   arrives wrapped — an envelope element around the payload, a `<head>` whose `<title>` is a filename
 *   rather than content, `<script>`/`<style>` blocks that are neither — and every strategy downstream
 *   should reason about the same narrowed window rather than each re-deriving one.
 *
 *   Returns HTML, not text: the caller still has a document to parse. `#html/text` answers the text
 *   question and `#html/tables` the grid question.
 */

import render from "dom-serializer"
import type { AnyNode } from "domhandler"
import { findAll, removeElement, textContent } from "domutils"
import { parseDocument } from "htmlparser2"

export interface DocumentSliceOptions {
	/**
	 * Narrow to the inner HTML of the FIRST element with this (lower-case) name — an SGML/XML envelope's payload element.
	 * A document that states no such element is not narrowed, which is the right reading for a bare fragment that never
	 * had an envelope.
	 */
	within?: string
	/**
	 * Element names to remove entirely, applied AFTER {@linkcode DocumentSliceOptions.within} so an envelope's own
	 * metadata is never mistaken for the payload's.
	 */
	without?: readonly string[]
}

/**
 * Narrows `html` to the window described by `options` and renders it back to HTML. One parse, and the tree answers both
 * questions — a regex `<head[^>]*>[\s\S]*?<\/head>` cannot tell a `<` inside an attribute value from a tag, and a
 * document whose envelope is malformed is exactly the document a caller most needs read correctly.
 */
export function sliceDocument(html: string, options: DocumentSliceOptions = {}): string {
	const document = parseDocument(html, { decodeEntities: true })

	const envelope = options.within ? findAll((element) => element.name === options.within, document).at(0) : undefined

	const roots: AnyNode[] = envelope ? envelope.children : document.children

	if (options.without?.length) {
		const removed = new Set(options.without)

		// Collected before removal: `removeElement` detaches a node from its parent, and a live tree walk over a
		// list it is mutating skips siblings.
		for (const unwanted of findAll((element) => removed.has(element.name), roots)) {
			removeElement(unwanted)
		}
	}

	// `roots` is the live children array of the envelope (or the document), and `removeElement` splices each
	// node out of its own parent — so the array read here is already the narrowed window.
	return render(roots)
}

/**
 * Whether to read `markup` as XML. XML mode keeps tag case and treats every element as needing an explicit close, which
 * is what an OGC exception report, an FGDC metadata document, or an S3 listing want. HTML mode recovers unclosed tags
 * the way a browser does, which is what a filing wants.
 */
export interface MarkupQueryOptions {
	xml?: boolean
}

/**
 * The LOCAL name of an element — `gco:CharacterString` is `characterstring`. A namespace prefix is the publisher's
 * choice of alias and two documents from the same service can spell it differently; the local name is the contract.
 */
function localName(name: string): string {
	const colon = name.lastIndexOf(":")

	return (colon === -1 ? name : name.slice(colon + 1)).toLowerCase()
}

/**
 * The text of every element named `name`, in document order — namespace prefix ignored, entities decoded, nested markup
 * flattened to its text. An empty array when the document states no such element, which is a real answer: the element
 * is absent, as distinct from present and empty.
 */
export function elementTexts(markup: string, name: string, options: MarkupQueryOptions = {}): string[] {
	const wanted = localName(name)
	const document = parseDocument(markup, { decodeEntities: true, xmlMode: options.xml ?? false })

	return findAll((element) => localName(element.name) === wanted, document).map((element) => textContent(element))
}

/**
 * The text of the FIRST element named `name`, or `undefined` when the document states none.
 */
export function elementText(markup: string, name: string, options: MarkupQueryOptions = {}): string | undefined {
	return elementTexts(markup, name, options).at(0)
}

/**
 * One attribute of the document's ROOT element, or `undefined` when the root carries no such attribute. Asked of the
 * root specifically, so a value repeated on a descendant cannot answer for the document — the count a service reports
 * for a collection is a property of the collection, and a regex over the whole body cannot tell the two apart.
 */
export function rootAttribute(markup: string, attribute: string, options: MarkupQueryOptions = {}): string | undefined {
	const document = parseDocument(markup, { decodeEntities: true, xmlMode: options.xml ?? false })
	const root = findAll(() => true, document).at(0)

	if (!root) return undefined

	const wanted = attribute.toLowerCase()

	for (const [key, value] of Object.entries(root.attribs)) {
		if (localName(key) === wanted) return value
	}

	return undefined
}
