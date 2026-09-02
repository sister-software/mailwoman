/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The vocabulary an SEC Exhibit 21 filing states about its own columns and rows.
 *
 *   Every label, pattern and predicate here is US SEC filing vocabulary — "state or other jurisdiction of
 *   incorporation" is a phrase from a disclosure form, not a fact about HTML tables. It sits in `@mailwoman/filer`
 *   beside the parser that reads it, and the generic grid machinery it is applied to sits in
 *   `@mailwoman/core/html/tables` with no knowledge of any of it.
 *
 *   `carriesLegalDesignation` is why this separation is load-bearing rather than tidy: it reaches
 *   `@mailwoman/record`, which depends on `@mailwoman/formatter`, which depends on `@mailwoman/core` — so the same
 *   predicate inside core closes an import cycle across three packages.
 */

import { canonicalizeOrganizationName } from "@mailwoman/record"

/**
 * Matches a cell value made only of punctuation and whitespace — a decorative rule row (`"----"`, `"======="`), which
 * no legal entity name can be.
 */
const DECORATIVE_ONLY_PATTERN = /^[^a-z0-9]*$/i

/**
 * Matches any letter or digit — tests whether a value carries real text at all.
 */
const LETTER_OR_DIGIT_PATTERN = /[a-z0-9]/i

/**
 * Column labels that name a JURISDICTION column. Exactly one of these in a header row is what licenses a column mapping
 * — the document says which column means what, so reading it is not guessing.
 */
export const JURISDICTION_HEADER_LABELS = new Set<string>([
	"jurisdiction",
	"jurisdiction of incorporation",
	"jurisdiction of incorporation or organization",
	"jurisdiction of incorporation or formation",
	"jurisdiction of organization",
	"jurisdiction of formation",
	"state",
	"country",
	"domicile",
	"state of incorporation",
	"state of organization",
	"state of formation",
	"state or jurisdiction of incorporation",
	"state or other jurisdiction of incorporation",
	"state or country of incorporation",
	"state of incorporation / organization",
	"state of incorporation/organization",
	"state of incorporation or formation",
	"state of incorporation/formation",
	"state/country of organization",
	"state/country of formation",
])

/**
 * Column labels that name a column which is NEITHER the entity name NOR its jurisdiction — a trade name, an ownership
 * percentage, a tax ID. A column mapping skips these when picking the name column, and every one of them is also a
 * header label in its own right.
 */
export const OTHER_HEADER_LABELS = new Set<string>([
	"% of ownership",
	"% owned",
	"ownership",
	"ownership percentage",
	"percentage owned",
	"percent owned",
	"name doing business as",
	"conducts business under",
	"d/b/a",
	"dba",
	"other name(s) under which entity does business",
	"ein",
])

/**
 * Column labels that name the ENTITY NAME column, plus the section headings and document titles EDGAR filings state as
 * a `<td>` row of their own ("Domestic Subsidiaries", "Subsidiaries of the Registrant").
 */
const NAME_HEADER_LABELS = new Set<string>([
	"name",
	"entity name",
	"legal name",
	"legal entity",
	"full legal name",
	"name of entity",
	"subsidiary name",
	"subsidiary companies",
	"name of subsidiary",
	"name of subsidiaries",
	"subsidiary",
	"subsidiaries",
	"subsidiaries of the registrant",
	"list of subsidiaries",
	"domestic subsidiaries",
	"foreign subsidiaries",
	"exhibit 21",
	"exhibit 21.1",
	"registrant",
])

/**
 * Every label a header row may use: jurisdiction, name and 'other' labels.
 */
const KNOWN_HEADER_LABELS = new Set<string>([
	...JURISDICTION_HEADER_LABELS,
	...OTHER_HEADER_LABELS,
	...NAME_HEADER_LABELS,
])

/**
 * Recognizes a row/line as a document HEADER or pure-decoration row rather than a data row — deliberately NOT
 * substring/keyword sniffing, which would misfire on a company literally named e.g. "Subsidiary Holdings LLC". Two
 * narrow checks, both applied to every non-blank value: pure decoration (no letter or digit anywhere in it, which no
 * legal entity name can be), or an EXACT case-insensitive match against the short fixed list of literal boilerplate
 * phrases EDGAR Exhibit 21 filings actually use. All-blank input is NOT a header/decoration row (that is the
 * empty-row/blank-name handling's job, not this one's).
 */
export function isHeaderOrDecorationRow(values: readonly string[]): boolean {
	const nonBlank = values.filter((value) => value !== "")

	if (!nonBlank.length) return false

	return nonBlank.every((value) => DECORATIVE_ONLY_PATTERN.test(value) || KNOWN_HEADER_LABELS.has(value.toLowerCase()))
}

/**
 * A row whose FIRST non-blank value is nothing but a footnote marker — `(1)`, `[2]`, `3`, `*`, `***`. The row is the
 * footnote's own text, not a subsidiary: `widepoint-2025.htm`'s second table is `[(1), "In January 2019, WidePoint
 * Solutions Corp. was merged into…"]`, and `echostar-2025.htm`/`atn-international-2025.htm` state one such table per
 * footnote. Checked BEFORE any column mapping is consulted, so a footnote table trailing a labelled list never inherits
 * that list's mapping.
 */
export const FOOTNOTE_MARKER_PATTERN = /^[([]?\d{1,3}[)\]]?$|^\*{1,3}$/

/**
 * True when `value` carries a corporate legal designation ("Inc.", "LLC", "Limited") — `canonicalizeOrganizationName`
 * (`@mailwoman/record`) returns a non-empty `designations` array exactly then. Verified against the corpus on
 * 2026-08-03: `"IDT Payment Services, Inc*. (DE)"` → `["inc"]`, while `"South Carolina"`, `"Delaware"`, `"British
 * Columbia, Canada"`, `"England and Wales"` and `"DE"` all → `[]`. Used by {@linkcode isMultiValueCell} and the
 * name-over-name table rule to tell an entity name from a place — never on its own, always alongside a second
 * condition, because a jurisdiction CAN carry one (Charter writes `"Delaware limited liability company"`).
 */
export function carriesLegalDesignation(value: string): boolean {
	return (canonicalizeOrganizationName(value)?.designations.length ?? 0) > 0
}

/**
 * True when ONE cell holds several ENTITY VALUES the source kept in separate blocks — a split point with a COMPLETE
 * legal entity name on both sides of it. `ooma-2025.htm`'s last row is a single `<td>` holding five `<p>` blocks;
 * reading it as one string runs them together into `"Trunking.IO, LLC FluentStream Corp. FluentStream Intermediate, LLC
 * …"` against a jurisdiction of `"Delaware Delaware Delaware Colorado Delaware"`, which is five fabricated claims, not
 * one. Decision 6: the row states more than this parser can align, so it abstains.
 *
 * A block boundary alone is NOT enough, and this is the rule's whole difficulty: EDGAR's Word/Workiva exporters also
 * emit a SOFT LINE WRAP as a block boundary, so `att-2025.htm` states one name as `<div>Illinois Bell
 * Telephone</div><div>&#160;&#160;Company, LLC</div>` — text in both blocks, one entity. What separates the two is that
 * each half of a genuine multi-value cell is a whole legal name carrying its own designation
 * (`canonicalizeOrganizationName` — `"Trunking.IO, LLC"` / `"FluentStream Corp. …"` both do), whereas a wrap splits ONE
 * name's designation off the front half (`"Illinois Bell Telephone"` carries none). Ten of AT&T's nineteen subsidiaries
 * are stated on wrapped rows.
 *
 * Each side is CUMULATIVE, not the adjacent block: a name may itself wrap across two blocks, and the question is
 * whether the cell can be split in two, not whether two neighbours happen to look complete.
 */
export function isMultiValueCell(blocks: readonly string[]): boolean {
	for (let split = 1; split < blocks.length; split++) {
		const before = blocks.slice(0, split).join(" ")
		const after = blocks.slice(split).join(" ")

		if (!LETTER_OR_DIGIT_PATTERN.test(before) || !LETTER_OR_DIGIT_PATTERN.test(after)) continue

		if (carriesLegalDesignation(before) && carriesLegalDesignation(after)) return true
	}

	return false
}
