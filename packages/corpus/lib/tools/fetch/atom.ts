/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reads an INSPIRE predefined-dataset ATOM feed into its links and entries.
 *
 *   Several member states serve the Addresses (AD) theme as an ATOM feed rather than as a WFS, so
 *   this is the shape a fetcher reads before it downloads anything. The elements are the same at
 *   both levels of a two-level service: a service document's entry points at a dataset feed, and
 *   that feed's entries point at files, and both are `<entry>` with `<link>` children.
 *
 *   Parsed with `@mailwoman/core/html/elements` rather than matched with a pattern, because a feed
 *   needs the two things a pattern handles badly. An entry's open tag holds attributes
 *   (`xml:lang`), and an href escapes the ampersand between its query parameters, so a reader has to
 *   keep attributes and decode entities. XML mode is required: a feed's links self-close, and HTML
 *   mode leaves them open.
 *
 *   Feed-level links are told from entry-level links by the parser rather than by position. One request
 *   for `link` and `entry` together yields a `link` only where it is not already inside an `entry`,
 *   because capture runs to the outermost requested element's close.
 */

import { childElement, childElements, type MarkupElement, streamMarkupElements } from "@mailwoman/core/html/elements"

/**
 * One `<link>` of a feed or of one of its entries.
 *
 * `rel` is lower-cased, since it is a controlled value, while `href`, `type`
 * and `title` are kept as the publisher wrote them.
 */
export interface AtomLink {
	href: string
	/**
	 * The relation, lower-cased, or an empty string where the link states none.
	 */
	rel: string
	/**
	 * The media type the link advertises, or `null` where it advertises none.
	 *
	 * A publisher may advertise the type of the data inside the file rather than of the file:
	 * ČÚZK writes `application/gml+xml` on a link that serves `application/zip`.
	 */
	type: string | null
	title: string | null
	/**
	 * The byte count the link claims, or `null` where it claims none or claims a non-numeric one.
	 *
	 * Never taken as the size of a download.
	 * Denmark's feed understates its file by 23 times, so every byte count a fetcher
	 * records is counted off the delivered body instead.
	 */
	length: number | null
}

/**
 * One `<entry>` of a feed.
 */
export interface AtomEntry {
	/**
	 * The entry's `<id>`, which is a URI rather than a name.
	 */
	id: string
	title: string
	/**
	 * The entry's `<updated>`, as the feed spells it, or an empty string where it states none.
	 *
	 * Whether this describes the data or the feed is a property of the publisher: Denmark's is
	 * older than the file it serves, while ČÚZK's equals the file's `Last-Modified` to the second.
	 * A fetcher that reads it for freshness has to have measured that agreement first.
	 */
	updated: string
	/**
	 * The entry's `<rights>`, or `null` where it states none.
	 */
	rights: string | null
	links: readonly AtomLink[]
	/**
	 * The entry's `inspire_dls:spatial_dataset_identifier_code`, or `null` for a
	 * feed that is not an INSPIRE predefined-dataset feed.
	 */
	identifierCode: string | null
}

/**
 * A feed's own links and its entries.
 */
export interface AtomFeed {
	/**
	 * The feed's own links. These sit outside every entry.
	 */
	links: readonly AtomLink[]
	entries: readonly AtomEntry[]
}

function atomLinkOf(element: MarkupElement): AtomLink {
	const length = element.attributes.length

	return {
		href: element.attributes.href ?? "",
		rel: (element.attributes.rel ?? "").toLowerCase(),
		type: element.attributes.type ?? null,
		title: element.attributes.title ?? null,
		length: length !== undefined && /^\d+$/u.test(length) ? Number(length) : null,
	}
}

function atomEntryOf(element: MarkupElement): AtomEntry {
	return {
		id: childElement(element, "id")?.text ?? "",
		title: childElement(element, "title")?.text ?? "",
		updated: childElement(element, "updated")?.text ?? "",
		rights: childElement(element, "rights")?.text ?? null,
		links: childElements(element, "link").map(atomLinkOf),
		identifierCode: childElement(element, "inspire_dls:spatial_dataset_identifier_code")?.text ?? null,
	}
}

/**
 * Read a feed's links and entries out of its markup.
 *
 * The reader streams because a service document may be large:
 * ČÚZK's lists one entry per municipality.
 *
 * @param chunks The feed's bytes or text, in order.
 * A Node `Readable` satisfies this.
 * @throws When the markup is malformed, through the parser, so an unreadable feed raises
 * rather than reading as a feed with fewer entries.
 */
export async function readAtomFeed(chunks: AsyncIterable<string | Uint8Array>): Promise<AtomFeed> {
	const links: AtomLink[] = []
	const entries: AtomEntry[] = []

	for await (const element of streamMarkupElements(chunks, ["link", "entry"], { xml: true })) {
		if (element.name === "entry") {
			entries.push(atomEntryOf(element))

			continue
		}

		links.push(atomLinkOf(element))
	}

	return { links, entries }
}

/**
 * The feed's text as the one chunk {@linkcode readAtomFeed} takes.
 *
 * For a caller that already holds the whole document, such as a test
 * or a feed read through a buffering client.
 */
export async function* feedChunks(text: string): AsyncIterable<string> {
	yield text
}

/**
 * The first link carrying `rel`, or `undefined` where the collection holds none.
 *
 * A feed's entry commonly holds several: ČÚZK writes a `describedby` link to its ISO 19139
 * record beside the `alternate` link that is the data, and either would download as a dataset.
 */
export function linkWithRel(links: readonly AtomLink[], rel: string): AtomLink | undefined {
	return links.find((link) => link.rel === rel.toLowerCase())
}
