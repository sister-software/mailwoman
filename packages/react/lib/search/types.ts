/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The record the docs build indexes and the response the search modal renders. The modal and the
 *   query code share these through `import type`.
 */

/**
 * The number of hierarchy entries: the sidebar category, then `h1` through `h6`.
 */
export const HIERARCHY_DEPTH = 7

export interface SearchRecord {
	/**
	 * The first 32 hex characters of `sha256(url + "#" + anchor + "\n" + position)`.
	 */
	id: string
	/**
	 * Site-relative path without the anchor, such as `/docs/developers/reference/cli`.
	 */
	url: string
	/**
	 * The heading id the record links to, or the empty string for the top of the page.
	 */
	anchor: string
	/**
	 * Seven entries, `lvl0` through `lvl6`, with `null` below the record's own level.
	 */
	hierarchy: (string | null)[]
	/**
	 * Aggregated text under the heading, or the empty string for a heading without body text.
	 */
	content: string
	/**
	 * Depth of the deepest non-null hierarchy entry, 0 through 6.
	 */
	level: number
	/**
	 * Zero-based order of the record on its page.
	 */
	position: number
}

export interface SearchHit {
	url: string
	anchor: string
	hierarchy: (string | null)[]
	/**
	 * At most 160 characters of content around the first match.
	 */
	snippet: string
	/**
	 * Character ranges within `snippet` that matched a query token.
	 */
	highlights: [start: number, end: number][]
}

export interface SearchResponse {
	query: string
	/**
	 * The text actually searched when a token was corrected against the vocabulary.
	 */
	corrected?: string
	hits: SearchHit[]
}
