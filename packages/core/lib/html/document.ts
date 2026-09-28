/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Narrows a document to the markup worth reading before downstream code parses it.
 *   An archive can wrap its payload in an envelope element. Its `<head>` title can contain a filename.
 *   Its `<script>` and `<style>` blocks do not contain document content.
 *   Downstream strategies should read the same narrowed window instead of deriving their own.
 *
 *   The function returns HTML so the caller can still parse a document.
 *   `#html/text` extracts text. `#html/tables` reads grids.
 */

import render from "dom-serializer"
import type { AnyNode } from "domhandler"
import { findAll, removeElement, textContent } from "domutils"
import { parseDocument } from "htmlparser2"

export interface DocumentNarrowingOptions {
	/**
	 * Narrow to the inner html of the first element with this (lower-case) name —
	 * an sgml/XML envelope's payload element.
	 *
	 * A document that states no such element remains unchanged.
	 * That result is correct for a bare fragment that never had an envelope.
	 */
	within?: string
	/**
	 * Element names to remove entirely, applied after {@linkcode DocumentNarrowingOptions.within}
	 * so an envelope's own metadata is never mistaken for the payload's.
	 */
	without?: readonly string[]
}

/**
 * Narrows `html` to the window described by `options` and renders it back to html.
 *
 * One parse provides the tree for both operations.
 * A regex such as `<head[^>]*>[\s\S]*?<\/head>` cannot distinguish a `<` in an attribute value from a tag.
 *
 * Callers also need correct results when an envelope is malformed.
 */
export function narrowDocument(html: string, options: DocumentNarrowingOptions = {}): string {
	const document = parseDocument(html, { decodeEntities: true })

	const envelope = options.within ? findAll((element) => element.name === options.within, document).at(0) : undefined

	const roots: AnyNode[] = envelope ? envelope.children : document.children

	if (options.without?.length) {
		const removed = new Set(options.without)

		// The code collects nodes before removing them because `removeElement`
		// detaches each node from its parent.
		// A live tree walk over a list it mutates skips siblings.
		for (const unwanted of findAll((element) => removed.has(element.name), roots)) {
			removeElement(unwanted)
		}
	}

	// `roots` is the live children array of the envelope or document.
	// `removeElement` splices each node out of its own parent.
	// So the array read here is already the narrowed window.
	return render(roots)
}

/**
 * Whether to read `markup` as XML.
 *
 * XML mode keeps tag case and requires an explicit close for every element.
 * OGC exception reports use that behavior.
 *
 * FGDC metadata documents use it too.
 * S3 listings use it as well.
 *
 * HTML mode recovers unclosed tags as a browser does.
 * Filing documents use that behavior.
 */
export interface MarkupQueryOptions {
	xml?: boolean
}

/**
 * The local name of an element — `gco:CharacterString` is `characterstring`.
 *
 * A namespace prefix is the publisher's choice of alias.
 * Two documents from the same service can spell it differently.
 * The local name is the interface.
 */
function localName(name: string): string {
	const colon = name.lastIndexOf(":")

	return (colon === -1 ? name : name.slice(colon + 1)).toLowerCase()
}

/**
 * Returns the text of every element with the tag `name` in document order.
 *
 * The function ignores namespace prefixes.
 * It decodes entities and flattens nested markup.
 *
 * An empty array means the document states no such element.
 * The element is absent, rather than present and empty.
 */
export function elementTexts(markup: string, name: string, options: MarkupQueryOptions = {}): string[] {
	const wanted = localName(name)
	const document = parseDocument(markup, { decodeEntities: true, xmlMode: options.xml ?? false })

	return findAll((element) => localName(element.name) === wanted, document).map((element) => textContent(element))
}

/**
 * The text of the first element with the tag `name`, or `undefined` when the document states none.
 */
export function elementText(markup: string, name: string, options: MarkupQueryOptions = {}): string | undefined {
	return elementTexts(markup, name, options).at(0)
}

/**
 * One attribute of the document's root element, or `undefined` when the root carries no such attribute.
 *
 * Asked of the root specifically, so a value repeated on a descendant cannot answer for the document.
 * A service's collection count describes the collection.
 *
 * A regex over the whole body cannot distinguish that count from a repeated descendant value.
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
