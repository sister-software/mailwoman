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
import { findAll, removeElement } from "domutils"
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
