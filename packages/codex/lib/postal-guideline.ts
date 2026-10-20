/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The citation stored on each row of a per-country postal rule table.
 *
 *   A module header's `@see` link tells a reader where a rule came from. A row that stores its
 *   citation lets a generator or a check read the source with the rule: the document, its edition,
 *   the section, the sentence quoted from the fetched copy, and the hash of that copy. A row
 *   without a citation is refused by {@linkcode assertPostalGuidelineCitation}.
 */

/**
 * Where one postal rule is stated, as read from a fetched copy of the operator's publication.
 */
export interface PostalGuidelineCitation {
	/**
	 * The publication's title as the publisher prints it.
	 */
	document: string
	/**
	 * The postal operator or standards body that publishes the document.
	 */
	publisher: string
	/**
	 * The edition, version or date the document states, or `undated` when it states none.
	 */
	edition: string
	/**
	 * The section, table or heading that states the rule.
	 */
	section: string
	/**
	 * The rule's sentence or table row, copied from the fetched copy.
	 */
	quote: string
	/**
	 * How the quote was transcribed when it is not one contiguous run of the copy's text,
	 * such as table cells whose column padding was collapsed to one space.
	 * Null when the quote is contiguous.
	 */
	transcription: string | null
	/**
	 * The URL the copy was fetched from.
	 */
	url: string
	/**
	 * The SHA-256 of the fetched bytes, in lower-case hex.
	 */
	sha256: string
	/**
	 * The date the copy was fetched, `YYYY-MM-DD`.
	 */
	fetched: string
}

/**
 * One rule for writing a post-office box or its national equivalent, with its citation.
 */
export interface PoBoxGuidelineRule {
	/**
	 * A stable id for the rule, unique within its country's table.
	 */
	id: string
	/**
	 * The designator as the cited document writes it on the delivery line.
	 */
	designator: string
	/**
	 * Whether the cited document gives the designator a number after it.
	 */
	requiresNumber: boolean
	/**
	 * Whether the cited document asks for the office that holds the box on the same line.
	 */
	requiresOffice: boolean
	/**
	 * The rule restated in English.
	 */
	statement: string
	citation: PostalGuidelineCitation
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u

/**
 * Throws unless every field a citation needs is present and well formed.
 *
 * @param label - Names the rule in the error message.
 */
export function assertPostalGuidelineCitation(citation: PostalGuidelineCitation, label: string): void {
	for (const field of ["document", "publisher", "edition", "section", "quote", "url"] as const) {
		if (!citation[field]?.trim()) throw new Error(`${label}: the citation has no ${field}.`)
	}

	if (!SHA256_PATTERN.test(citation.sha256)) {
		throw new Error(`${label}: the citation's sha256 is not 64 lower-case hex digits: ${citation.sha256}`)
	}

	if (!DATE_PATTERN.test(citation.fetched)) {
		throw new Error(`${label}: the citation's fetched date is not YYYY-MM-DD: ${citation.fetched}`)
	}
}
