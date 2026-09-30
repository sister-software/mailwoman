/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Every label and predicate here is US SEC filing vocabulary rather than a fact about html tables.
 * it lives in `@mailwoman/filer` because `carriesLegalDesignation` reaches `@mailwoman/record`, whose
 * dependency on `@mailwoman/formatter` and `@mailwoman/core` would close an import cycle inside core.
 */

import { canonicalizeOrganizationName } from "@mailwoman/record"

/**
 * Matches a cell value made only of punctuation and whitespace.
 *
 * No legal entity name can be (a decorative rule row such as `"----"` or `"======="`).
 */
const DECORATIVE_ONLY_PATTERN = /^[^a-z0-9]*$/i

const LETTER_OR_DIGIT_PATTERN = /[a-z0-9]/i

/**
 * Column labels that name a jurisdiction column.
 *
 * Exactly one of these in a header row licenses a column mapping.
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
 * Column labels that name a column which is neither the entity name nor its jurisdiction,
 * such as a trade name, an ownership percentage, or a tax ID. a column mapping
 * skips these when picking the name column.
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
 * Column labels that name the entity name column, plus the section headings
 * and document titles edgar filings state as a `<td>` row of their own.
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

const KNOWN_HEADER_LABELS = new Set<string>([
	...JURISDICTION_HEADER_LABELS,
	...OTHER_HEADER_LABELS,
	...NAME_HEADER_LABELS,
])

/**
 * Recognizes a row/line as a document header or pure-decoration row rather than a data row. the
 * exact match rather than substring sniffing avoids misfiring on a company literally called
 * e.g. "Subsidiary Holdings LLC", and an all-blank row is left to the empty-row handling.
 */
export function isHeaderOrDecorationRow(values: readonly string[]): boolean {
	const nonBlank = values.filter((value) => value !== "")

	if (!nonBlank.length) return false

	return nonBlank.every((value) => DECORATIVE_ONLY_PATTERN.test(value) || KNOWN_HEADER_LABELS.has(value.toLowerCase()))
}

/**
 * Matches a row whose first non-blank value is only a footnote marker (`(1)`, `[2]`, `3`, `*`, `***`);
 * checked before any column mapping so a footnote table never inherits a preceding list's mapping.
 */
export const FOOTNOTE_MARKER_PATTERN = /^[([]?\d{1,3}[)\]]?$|^\*{1,3}$/

/**
 * True when `value` contains a corporate legal designation ("Inc.", "LLC", "Limited"); used only
 * alongside a second condition, because a jurisdiction can contain one (Charter writes `"Delaware
 * limited liability company"`).
 */
export function carriesLegalDesignation(value: string): boolean {
	return (canonicalizeOrganizationName(value)?.designations.length ?? 0) > 0
}

/**
 * True when one cell holds several entity values the source kept in separate blocks.
 * a block boundary by itself is not enough because exporters emit soft line wraps as
 * block boundaries, so both cumulative sides must contain their own legal designation
 * before the cell reads as multiple entities.
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
