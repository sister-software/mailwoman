/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads complete elements out of a markup stream, one subtree at a time.
 *
 * `./document.ts` parses a whole document into memory and answers text queries against it. That fits
 * a page. It does not fit a feature collection: one INSPIRE Addresses download inflates to roughly 32
 * GB of GML, and the caller wants each `ad:Address` subtree rather than the document.
 *
 * This module yields one matching element at a time, with its attributes and its nested children, and
 * holds only the elements a single chunk completed. A caller reads an attribute. `./document.ts`
 * cannot do that except on the root. A caller also walks a nested path. `elementTexts` flattens
 * that path.
 *
 * It decodes bytes with a streaming `TextDecoder`, so a multi-byte character split across two chunks
 * survives.
 */

import { Parser } from "htmlparser2"

/**
 * One element and the subtree beneath it.
 */
export interface MarkupElement {
	/**
	 * The tag as the document spells it, including its namespace prefix: `ad:Address`.
	 *
	 * XML mode preserves case.
	 * HTML mode lower-cases, as HTML parsing requires.
	 */
	readonly name: string

	/**
	 * The element's attributes, keyed as the document spells them: `xlink:href`, `gml:id`.
	 */
	readonly attributes: Readonly<Record<string, string>>

	/**
	 * The elements directly inside this one, in document order.
	 *
	 * A repeated tag appears once per occurrence, so a caller can tell `ad:component`
	 * number three from number one.
	 */
	readonly children: readonly MarkupElement[]

	/**
	 * The text directly inside this element, trimmed, with no text from its children.
	 *
	 * A child's text stays out, so a caller reading a leaf gets that leaf's value
	 * rather than a concatenation of everything beneath its parent.
	 */
	readonly text: string
}

interface MutableElement {
	name: string
	attributes: Record<string, string>
	children: MutableElement[]
	text: string
}

/**
 * How to read the stream.
 */
export interface StreamMarkupOptions {
	/**
	 * Parse as XML.
	 * It preserves tag case and requires every element to close.
	 *
	 * GML and every other INSPIRE payload needs this.
	 * It defaults to false, matching `./document.ts`.
	 */
	xml?: boolean

	/**
	 * Stops reading when the caller aborts.
	 *
	 * The generator returns at the next chunk boundary rather than mid-element,
	 * so a caller never receives a partial subtree.
	 */
	signal?: AbortSignal
}

/**
 * The elements matching `name`, each complete, in document order.
 *
 * A nested element of the same name is not yielded separately: capture starts at the
 * outermost occurrence and ends when that one closes, so one `ad:Address` arrives
 * once however many `ad:Address` elements its own subtree contains.
 *
 * Several names read one document once.
 * An INSPIRE collection writes the features an address references before the addresses
 * themselves, so a caller that indexes `ad:ThoroughfareName` and reads `ad:Address` in
 * one pass avoids decompressing an 819 MB download once per element type.
 *
 * A requested name nested inside another is still skipped, because capture
 * runs to the outermost element's close.
 *
 * @param chunks The document's bytes or text, in order.
 * A Node `Readable` satisfies this.
 * @param name The tag or tags to yield, spelled as the document spells them.
 * @throws When the parser reports a malformed document, so an unreadable input raises
 * rather than ending the iteration early and reading as a short document.
 */
export async function* streamMarkupElements(
	chunks: AsyncIterable<string | Uint8Array>,
	name: string | readonly string[],
	options: StreamMarkupOptions = {}
): AsyncIterable<MarkupElement> {
	/**
	 * The tags to yield.
	 *
	 * A set rather than a comparison, so the cost of asking for several names is the cost of asking for one.
	 */
	const wanted = new Set(typeof name === "string" ? [name] : name)
	/**
	 * Elements completed by the chunk being parsed, drained after each write.
	 */
	const completed: MutableElement[] = []
	/**
	 * The open ancestry inside the element being captured, outermost first.
	 */
	const open: MutableElement[] = []
	/**
	 * The requested tag currently being captured.
	 *
	 * With several requested names, the close that ends a capture is the one matching
	 * the tag capture began on, rather than any requested name.
	 */
	let capturing: string | undefined
	let depth = 0
	let failure: Error | undefined

	const parser = new Parser(
		{
			onopentag(tag, attributes) {
				if (!open.length) {
					if (!wanted.has(tag)) return

					capturing = tag

					open.push({ name: tag, attributes: { ...attributes }, children: [], text: "" })

					return
				}

				// Depth counts the nested occurrences of the tag being captured, so capture ends
				// at the right close rather than at an inner element of the same name.
				if (tag === capturing) {
					depth += 1
				}

				const element: MutableElement = { name: tag, attributes: { ...attributes }, children: [], text: "" }

				open.at(-1)!.children.push(element)
				open.push(element)
			},
			ontext(text) {
				const current = open.at(-1)

				if (current) {
					current.text += text
				}
			},
			onclosetag(tag) {
				if (!open.length) return

				if (open.length === 1) {
					if (tag !== capturing) return

					if (depth > 0) {
						depth -= 1

						return
					}

					completed.push(open.pop()!)
					capturing = undefined

					return
				}

				if (tag === capturing && depth > 0) {
					depth -= 1
				}

				open.pop()
			},
			onerror(error) {
				failure ??= error
			},
		},
		{ decodeEntities: true, xmlMode: options.xml ?? false }
	)

	const decoder = new TextDecoder("utf-8")

	/**
	 * The largest string decoded from one chunk.
	 *
	 * Eight mebibytes sits well under V8's maximum string length while keeping the number
	 * of parser writes proportional to the document rather than to the chunk size.
	 */
	const MAX_DECODED_CHUNK = 8 * 1024 * 1024

	const raise = (): void => {
		if (failure) throw new Error(`streamMarkupElements: the parser refused the document: ${failure.message}`)
	}

	/**
	 * Trims each element's own text while leaving its children untouched.
	 */
	const finish = (element: MutableElement): MarkupElement => ({
		name: element.name,
		attributes: element.attributes,
		text: element.text.trim(),
		children: element.children.map(finish),
	})

	/**
	 * The text of one chunk, in pieces small enough for `TextDecoder` to return a string.
	 *
	 * A caller that buffers a whole document and yields it once would otherwise
	 * ask for a string past V8's maximum length.
	 * The decoder's state persists across the pieces, so a multi-byte character spanning
	 * a slice boundary survives, as it does across chunks.
	 */
	const decodePieces = (chunk: Uint8Array): string[] => {
		if (chunk.length <= MAX_DECODED_CHUNK) return [decoder.decode(chunk, { stream: true })]

		const pieces: string[] = []

		for (let offset = 0; offset < chunk.length; offset += MAX_DECODED_CHUNK) {
			pieces.push(decoder.decode(chunk.subarray(offset, offset + MAX_DECODED_CHUNK), { stream: true }))
		}

		return pieces
	}

	for await (const chunk of chunks) {
		if (options.signal?.aborted) return

		for (const piece of typeof chunk === "string" ? [chunk] : decodePieces(chunk)) {
			parser.write(piece)

			raise()

			while (completed.length) {
				yield finish(completed.shift()!)
			}
		}
	}

	parser.end()

	raise()

	while (completed.length) {
		yield finish(completed.shift()!)
	}
}

/**
 * The first child of `element` with the tag `name`, or undefined.
 */
export function childElement(element: MarkupElement, name: string): MarkupElement | undefined {
	return element.children.find((child) => child.name === name)
}

/**
 * Every child of `element` with the tag `name`, in document order.
 */
export function childElements(element: MarkupElement, name: string): readonly MarkupElement[] {
	return element.children.filter((child) => child.name === name)
}

/**
 * The element reached by walking `path` from `element`, taking the first match at each step.
 *
 * An INSPIRE value sits five or six elements down, so the path form reads better than
 * a chain of `childElement` calls and reports the same absence.
 */
export function elementAtPath(element: MarkupElement, ...path: readonly string[]): MarkupElement | undefined {
	let current: MarkupElement | undefined = element

	for (const step of path) {
		if (!current) return undefined

		current = childElement(current, step)
	}

	return current
}

/**
 * The text at `path`, or undefined when any step of the path is absent.
 *
 * An empty element answers an empty string.
 * A caller distinguishes that from undefined: the publisher wrote the element
 * and left it blank, rather than omitting it.
 */
export function textAtPath(element: MarkupElement, ...path: readonly string[]): string | undefined {
	return elementAtPath(element, ...path)?.text
}
