/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * See `exhibit21-parser.md` for the parsing interface and abstention rules.
 */

import { narrowDocument } from "@mailwoman/core/html/document"
import { extractTableRows, padAndDropBlankColumns, type TableCell, widestRow } from "@mailwoman/core/html/tables"
import { BLOCK_ELEMENTS, htmlToLayoutText } from "@mailwoman/core/html/text"
import { isPresent } from "@mailwoman/core/objects"
import { normalizeWhitespace } from "@mailwoman/core/strings/format"
import { canonicalizeOrganizationName } from "@mailwoman/record"

import {
	carriesLegalDesignation,
	FOOTNOTE_MARKER_PATTERN,
	isHeaderOrDecorationRow,
	isMultiValueCell,
	JURISDICTION_HEADER_LABELS,
	OTHER_HEADER_LABELS,
} from "#sdk/exhibit21/vocabulary"

/**
 * One subsidiary {@linkcode parseExhibit21} confidently extracted.
 */
export interface ParsedSubsidiary {
	name: string
	/**
	 * Omitted rather than an empty string when Exhibit 21 gave no jurisdiction for this row/line.
	 * Decision 6 forbids guessing an absent jurisdiction.
	 */
	jurisdiction?: string
}

/**
 * {@linkcode parseExhibit21}'s result.
 *
 * `unparseable` is a count rather than a list of the offending text, since criterion
 * 3 requires only knowing that abstention happened and how often.
 */
export interface ParsedExhibit21 {
	subsidiaries: ParsedSubsidiary[]
	/**
	 * Rows/lines this parser recognized as an entry but could not confidently reduce to a subsidiary name.
	 *
	 * Decision 6 counts and drops them, and criterion 3 forbids throwing.
	 */
	unparseable: number
}

/**
 * The column indices a table's own header row assigns to the entity name and its jurisdiction.
 */
interface ColumnMapping {
	name: number
	jurisdiction: number
}

/**
 * The narrowest header row that establishes a mapping, counted in the row's own cells
 * before blank columns are dropped.
 *
 * A two-cell header would claim to describe a wider data row it never mentions, which is
 * `exhibit21-mangled.html`'s `Name of Subsidiary`/`State` shape over a third `"Note: ..."` cell.
 */
const MINIMUM_HEADER_ROW_CELLS = 3

/**
 * Reads a table's own header row to learn which column is the entity name and which is the
 * jurisdiction, returning `null` when no row qualifies so the caller keeps the preceding mapping.
 */
function headerColumnMapping(
	rows: readonly TableCell[][],
	extractedRows: readonly TableCell[][]
): ColumnMapping | null {
	for (const [rowIndex, row] of rows.entries()) {
		if ((extractedRows[rowIndex]?.length ?? 0) < MINIMUM_HEADER_ROW_CELLS) continue

		const values = row.map((cell) => cell.text)

		if (!isHeaderOrDecorationRow(values)) continue

		const jurisdictionColumns = values.flatMap((value, index) =>
			value && JURISDICTION_HEADER_LABELS.has(value.toLowerCase()) ? [index] : []
		)

		if (jurisdictionColumns.length !== 1) continue

		const jurisdiction = jurisdictionColumns[0]!

		for (const [index, value] of values.entries()) {
			if (index === jurisdiction) continue

			if (value && OTHER_HEADER_LABELS.has(value.toLowerCase())) continue

			return { name: index, jurisdiction }
		}
	}

	return null
}

/**
 * True when the table is a two-across list of entity names with no jurisdiction column.
 * the whole table abstains, because reading its second column as a jurisdiction would
 * emit one company as another company's place of incorporation.
 *
 * Distinctness is the separating condition: a jurisdiction column repeats
 * (Charter 0.07, Comcast 0.05, Uniti 0.13, T-Mobile 0.15, Lumen 0.26) while a second
 * name column does not (IDT 1.00), and Charter's `"Delaware limited liability company"`
 * makes 135 of 135 values carry a designation on a genuine jurisdiction list.
 */
const MINIMUM_NAME_OVER_NAME_ROWS = 4

/**
 * More than half the second values must carry a legal designation. A genuine jurisdiction column is
 * 0/N except where the filer spells the entity type out (Charter's `"Delaware limited liability
 * company"`, 135/135), which {@linkcode DISTINCT_SECOND_VALUE_RATIO} separates.
 */
const DESIGNATED_SECOND_VALUE_RATIO = 0.5

/**
 * More than 70% of the second values must be distinct.
 *
 * A jurisdiction column repeats (Charter 0.07, Comcast 0.05, Uniti 0.13, T-Mobile 0.15, Lumen 0.26)
 * while a second name column does not (IDT 1.00), and dropping this condition
 * loses all 135 Charter subsidiaries.
 */
const DISTINCT_SECOND_VALUE_RATIO = 0.7

function isNameOverNameTable(rows: readonly TableCell[][]): boolean {
	const seconds = rows.flatMap((row) => {
		const values = row.map((cell) => cell.text).filter(isPresent)

		if (values.length !== 2) return []

		if (FOOTNOTE_MARKER_PATTERN.test(values[0]!)) return []

		if (isHeaderOrDecorationRow(values)) return []

		return [values[1]!]
	})

	if (seconds.length < MINIMUM_NAME_OVER_NAME_ROWS) return false

	const designated = seconds.filter(carriesLegalDesignation)

	if (designated.length <= seconds.length * DESIGNATED_SECOND_VALUE_RATIO) return false

	return new Set(seconds).size > seconds.length * DISTINCT_SECOND_VALUE_RATIO
}

/**
 * The number of one-value rows a table needs to count as a plain single-column name list,
 * where a one-value row is a subsidiary rather than a section heading. a table
 * one cell wide qualifies without them.
 */
const MINIMUM_NAME_LIST_ROWS = 2

function isSingleColumnNameList(rows: readonly TableCell[][], rawWidth: number): boolean {
	if (!rows.length) return false

	const valueCounts = rows.map((row) => row.filter((cell) => cell.text !== "").length)

	if (!valueCounts.every((count) => count <= 1)) return false

	return valueCounts.filter((count) => count === 1).length >= MINIMUM_NAME_LIST_ROWS || rawWidth === 1
}

/**
 * Turns one top-level table's extracted rows into subsidiaries, returning the mapping
 * in force at the end so the caller can carry it to the next sibling.
 */
function subsidiariesFromTable(
	extractedRows: readonly TableCell[][],
	carriedMapping: ColumnMapping | null
): ParsedExhibit21 & { mapping: ColumnMapping | null } {
	const subsidiaries: ParsedSubsidiary[] = []
	let unparseable = 0

	// An empty <tr></tr> is formatting cruft rather than a data row.
	const present = extractedRows.filter((row) => row.length)
	const rawWidth = widestRow(present)
	const rows = padAndDropBlankColumns(present)
	const mapping = headerColumnMapping(rows, present) ?? carriedMapping

	if (!mapping && isNameOverNameTable(rows)) {
		return { subsidiaries, unparseable: rows.length, mapping }
	}

	const singleColumnList = isSingleColumnNameList(rows, rawWidth)

	for (const [rowIndex, row] of rows.entries()) {
		// Asked of the row as extracted, because right-padding adds `<td>` blanks that
		// carry no information about the row's markup.
		if (present[rowIndex]!.every((cell) => cell.tag === "th")) continue

		const values = row.map((cell) => cell.text)
		const nonBlank = values.filter(isPresent)

		if (!nonBlank.length) {
			unparseable++

			continue
		}

		// A `<td>` header/decoration row is a content judgment rather than markup
		// certainty, so decision 6 counts it.
		if (isHeaderOrDecorationRow(values)) {
			unparseable++

			continue
		}

		if (FOOTNOTE_MARKER_PATTERN.test(nonBlank[0]!)) {
			unparseable++

			continue
		}

		if (nonBlank.length === 1 && !singleColumnList) {
			unparseable++

			continue
		}

		const leadCell = row.find((cell) => cell.text !== "")!

		if (isMultiValueCell(leadCell.blocks)) {
			unparseable++

			continue
		}

		if (mapping) {
			let name = row[mapping.name]?.text ?? ""

			if (!name && mapping.name < mapping.jurisdiction) {
				// An indented child's name sits right of the labelled name column but left of
				// the labelled jurisdiction column, and the nesting depth is discarded.
				for (let column = mapping.name + 1; column < Math.min(mapping.jurisdiction, row.length); column++) {
					if (row[column]!.text) {
						name = row[column]!.text

						break
					}
				}
			}

			if (name) {
				const jurisdiction = row[mapping.jurisdiction]?.text ?? ""

				subsidiaries.push(jurisdiction ? { name, jurisdiction } : { name })

				continue
			}

			// A ragged table misaligns the mapping without making the row unreadable,
			// so fall through to the generic rules rather than abstaining.
		}

		if (nonBlank.length > 2) {
			// An extra column this parser has no confident meaning for (an ownership percentage, an EIN);
			// decision 6 abstains rather than guessing which two of N columns matter.
			unparseable++

			continue
		}

		if (!values[0]) {
			// A blank leading cell with no mapping to explain it is an unattributable
			// indented child or a misaligned spacer, and decision 6 abstains.
			unparseable++

			continue
		}

		const [name, jurisdiction] = nonBlank as [string, string?]

		subsidiaries.push(jurisdiction ? { name, jurisdiction } : { name })
	}

	return { subsidiaries, unparseable, mapping }
}

/**
 * Classifies every top-level table in document order and carries each table's column
 * mapping forward to its siblings until another header row replaces it, because edgar
 * splits one logical table across page-break tables and only the first carries the header.
 */
function subsidiariesFromTableRows(tables: readonly TableCell[][][]): ParsedExhibit21 {
	const subsidiaries: ParsedSubsidiary[] = []
	let unparseable = 0
	let mapping: ColumnMapping | null = null

	for (const rows of tables) {
		const result = subsidiariesFromTable(rows, mapping)

		subsidiaries.push(...result.subsidiaries)
		unparseable += result.unparseable
		mapping = result.mapping
	}

	return { subsidiaries, unparseable }
}

/**
 * Narrows one raw edgar archive document to the markup every strategy reasons about,
 * applied once in {@linkcode parseExhibit21} so all three strategies see the same window.
 *
 * The sgml `<text>` element is edgar's envelope around the exhibit, and a document with
 * no envelope is left whole; `<head>` goes because its `<title>` is the source filename
 * rather than a subsidiary, and `<script>`/`<style>` because their text is code.
 */
function documentWindow(html: string): string {
	return narrowDocument(html, { within: "text", without: ["head", "script", "style"] })
}

const LI_OPEN_PATTERN = /<li[^>]*>/gi
const LI_CHILD_BOUNDARY_PATTERN = /<ul[^>]*>|<ol[^>]*>|<li[^>]*>|<\/li>/i

/**
 * Extracts each `<li>`'s own text up to its first child `<ul>`/`<ol>`/`<li>` or its closing `</li>`,
 * which separates a parent's line from its nested children without balanced-tag tracking.
 */
function extractListItemOwnText(html: string): string[] {
	const lines: string[] = []

	for (const match of html.matchAll(LI_OPEN_PATTERN)) {
		const start = match.index + match[0].length
		const rest = html.slice(start)
		const boundaryIndex = rest.search(LI_CHILD_BOUNDARY_PATTERN)
		const ownHTML = boundaryIndex === -1 ? rest : rest.slice(0, boundaryIndex)
		const ownText = htmlToLayoutText(ownHTML)

		if (ownText.trim()) {
			lines.push(ownText)
		}
	}

	return lines
}

/**
 * Strips markup and splits into non-blank lines, leaving whitespace inside a
 * line uncollapsed so the 2+ spaces a fixed-width Exhibit 21 uses as its column
 * separator survive for {@linkcode splitCandidateLine}.
 *
 * Block-level element boundaries become real line breaks, and two adjacent boundaries
 * (`</p><p>`) are one separation rather than two.
 */
function extractPlainTextLines(html: string): string[] {
	const text = htmlToLayoutText(html, BLOCK_ELEMENTS)

	return text.split(/\r\n|\r|\n/).filter((line) => line.trim() !== "")
}

/**
 * True when `value` is just a corporate legal-entity suffix ("Inc.", "LLC", "Corp.")
 * with no other value, which guards {@linkcode splitCandidateLine}'s single-comma
 * rule against reading a name's own tail as a jurisdiction.
 */
function isBareLegalDesignation(value: string): boolean {
	const canonicalized = canonicalizeOrganizationName(value)

	return canonicalized !== null && canonicalized.canonical === "" && canonicalized.designations.length > 0
}

/**
 * The fixed-width column separator: a run of two or more spaces or tabs, with U+00A0
 * included because `&nbsp;` and `&#160;` state the same column.
 */
const COLUMN_GAP_PATTERN = /[ \t\u00A0]{2,}/

/**
 * Splits one candidate line into a name and an optional jurisdiction, trying a 2+-space
 * column gap, then a trailing `(Jurisdiction)` parenthetical, then exactly one comma,
 * and returning a blank name for a 3+-column gap so the caller counts the line `unparseable`.
 */
function splitCandidateLine(line: string): { name: string; jurisdiction?: string } {
	const spaced = line
		.split(COLUMN_GAP_PATTERN)
		.map((part) => normalizeWhitespace(part))
		.filter(isPresent)

	if (spaced.length === 2) {
		return { name: spaced[0]!, jurisdiction: spaced[1] }
	}

	if (spaced.length > 2) {
		return { name: "" }
	}

	const trimmedWhole = normalizeWhitespace(line)

	const parenMatch = /^(.*\S)\s*\(([^()]+)\)$/.exec(trimmedWhole)

	if (parenMatch) {
		return { name: parenMatch[1]!, jurisdiction: normalizeWhitespace(parenMatch[2]!) }
	}

	const commaParts = trimmedWhole.split(",")

	if (commaParts.length === 2) {
		const name = normalizeWhitespace(commaParts[0]!)
		const jurisdiction = normalizeWhitespace(commaParts[1]!)

		if (name && jurisdiction && !isBareLegalDesignation(jurisdiction)) return { name, jurisdiction }
	}

	return { name: trimmedWhole }
}

/**
 * A leading bullet or list-marker glyph, stripped before the name/jurisdiction split because the gap a
 * bullet leaves behind is a tag-stripping artifact that would otherwise be read as a column separator.
 */
const LIST_MARKER_PATTERN = /^[•●▪◦∙·*–—-]+\s*/

/**
 * Whole-line, case-insensitive shapes that are a document title or section heading, never an entity name.
 *
 * Whole-string patterns rather than keyword sniffing, because substring sniffing on
 * "subsidiaries" would misfire on a company actually named that.
 */
const TITLE_LINE_PATTERNS = [
	/^exhibit\s*21(\.\d+)?(\s*[-–—:]?\s*list of subsidiaries)?$/i,
	/^list of subsidiaries( of .+)?$/i,
	/^subsidiaries of .+$/i,
	/^.+ and subsidiaries$/i,
	/^(domestic|foreign|significant|principal) subsidiaries$/i,
	/^as of .+$/i,
]

/**
 * A candidate line longer than this many whitespace-separated tokens is abstained on
 * rather than split, because the longest legitimate name in the real-filing corpus
 * is 8 tokens and a preamble sentence is not a name at all.
 */
const MAX_ENTITY_NAME_WORDS = 12

/**
 * Shared by the list and plain-text strategies: strips a leading list marker,
 * abstains on a title/heading line or a line too long to be one name, splits
 * the rest, and applies the header/decoration-row check the table strategy uses
 * because a `<li>` document has no `<th>` markup to lean on.
 *
 * A line reduced to whitespace by the marker strip is counted `unparseable` like any other
 * blank name, since the marker character class overlaps plain decorative dashes.
 */
function subsidiariesFromLines(lines: readonly string[]): ParsedExhibit21 {
	const subsidiaries: ParsedSubsidiary[] = []
	let unparseable = 0

	for (const line of lines) {
		const unmarked = line.replace(LIST_MARKER_PATTERN, "")

		const wordCount = unmarked
			.trim()
			.split(/\s+/)
			.filter((value) => value.length).length

		if (wordCount > MAX_ENTITY_NAME_WORDS) {
			unparseable++

			continue
		}

		const normalizedWhole = normalizeWhitespace(unmarked)

		if (normalizedWhole && TITLE_LINE_PATTERNS.some((pattern) => pattern.test(normalizedWhole))) {
			unparseable++

			continue
		}

		const candidate = splitCandidateLine(unmarked)

		if (!candidate.name) {
			unparseable++

			continue
		}

		if (isHeaderOrDecorationRow([candidate.name, candidate.jurisdiction ?? ""])) {
			unparseable++

			continue
		}

		subsidiaries.push(
			candidate.jurisdiction ? { name: candidate.name, jurisdiction: candidate.jurisdiction } : { name: candidate.name }
		)
	}

	return { subsidiaries, unparseable }
}

/**
 * True when every extracted cell of every extracted row is blank, marking a decorative
 * border/spacer table that carries no subsidiary data.
 *
 * Committing to the table strategy the instant any `<table>` tag exists would
 * otherwise silence a list stated outside one.
 */
function isEntirelyBlankTable(tables: readonly TableCell[][][]): boolean {
	return tables.every((rows) => rows.every((row) => row.every((cell) => cell.text === "")))
}

/**
 * Parses an Exhibit 21 document into its subsidiary list, committing to the first
 * of an html `<table>`, an `<li>` list, or plain fixed-width text that it detects,
 * and counting rather than guessing at a row or line it cannot confidently extract
 * (decision 6, and never throwing under criterion 3).
 */
export function parseExhibit21(html: string): ParsedExhibit21 {
	const window = documentWindow(html)
	const tableRows = extractTableRows(window)

	if (tableRows !== null && !isEntirelyBlankTable(tableRows)) {
		return subsidiariesFromTableRows(tableRows)
	}

	const listLines = extractListItemOwnText(window)

	if (listLines.length) {
		return subsidiariesFromLines(listLines)
	}

	return subsidiariesFromLines(extractPlainTextLines(window))
}

/**
 * The subset of `SECClient` this module needs, taken by {@linkcode fetchExhibit21}
 * rather than the concrete class so a test can substitute a stub.
 */
export interface SECDocumentClient {
	getDocument(input: string | URL): Promise<string>
}

/**
 * Fetches one Exhibit 21 document through the shared SEC client's `getDocument` raw-text path and parses it.
 *
 * The caller supplies the URL, since discovering it is out of scope here.
 */
export async function fetchExhibit21(client: SECDocumentClient, url: string | URL): Promise<ParsedExhibit21> {
	const html = await client.getDocument(url)

	return parseExhibit21(html)
}
