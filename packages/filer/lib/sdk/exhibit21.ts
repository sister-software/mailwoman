/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Conservative SEC Exhibit 21 subsidiary parser.
 *
 * Recognizes measured table, list, and plain-text filing shapes and counts uncertain rows instead of inventing entities.
 * See `exhibit21-parser.md` for the parsing contract and abstention rules.
 */

import { sliceDocument } from "@mailwoman/core/html/document"
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
} from "#sdk/exhibit21-vocabulary"

/**
 * One subsidiary {@linkcode parseExhibit21} confidently extracted.
 */
export interface ParsedSubsidiary {
	name: string
	/**
	 * Omitted (never an empty string) when Exhibit 21 gave no jurisdiction for this row/line — decision 6: absence of a
	 * jurisdiction is not itself something to guess at.
	 */
	jurisdiction?: string
}

/**
 * {@linkcode parseExhibit21}'s result. `unparseable` is a COUNT, not a list of the offending text — criterion 3 only
 * requires knowing abstention happened and how often, not what was abstained from.
 */
export interface ParsedExhibit21 {
	subsidiaries: ParsedSubsidiary[]
	/**
	 * Rows/lines this parser recognized as an ENTRY (a table data row, a list item, a non-blank text line) but could not
	 * confidently reduce to a subsidiary name — decision 6: counted and dropped, never guessed at, and never thrown as an
	 * error either (criterion 3).
	 */
	unparseable: number
}

/**
 * The column indices a table's own header row assigns to the entity name and its jurisdiction. See
 * {@linkcode headerColumnMapping}.
 */
interface ColumnMapping {
	name: number
	jurisdiction: number
}

/**
 * The narrowest header row that establishes a mapping, counted in the row's OWN cells before blank columns are dropped.
 * A two-cell header has nothing to map that the generic "first value is the name, second is the jurisdiction" rule does
 * not already read the same way, so requiring three costs no fixture a single subsidiary — and it keeps a two-cell
 * header from claiming to describe a WIDER data row it never mentions, which is `exhibit21-mangled.html`'s shape
 * exactly: a `Name of Subsidiary`/`State` header over a row whose third cell is `"Note: pending name change"`. That row
 * is unreadable and must stay unreadable (criterion 3's required fixture asserts zero subsidiaries from it).
 */
const MINIMUM_HEADER_ROW_CELLS = 3

/**
 * Reads a table's own header row to learn which column is the entity name and which is the jurisdiction — the answer
 * the document itself states, rather than a guess about which two of N columns matter.
 *
 * A row qualifies as the header only when EVERY one of its non-blank values is a known label/decoration and EXACTLY ONE
 * of them is a jurisdiction label (two would be ambiguous, zero leaves nothing to anchor on). The name column is then
 * the first other column not labelled with an "other" label (`% of ownership`, `conducts business under`, `d/b/a`, …) —
 * `att-2025.htm`'s `["Legal Name", "State of Incorporation/Formation", "Conducts Business Under"]` maps to `{name: 0,
 * jurisdiction: 1}`, and `atn-international-2025.htm`'s unlabelled first column (its header row is `["", "Jurisdiction
 * of Incorporation", "Other name(s) under which entity does business"]`) still maps to `{name: 0, jurisdiction: 1}`.
 *
 * Returns `null` when no row qualifies; the caller then keeps whatever mapping a PRECEDING sibling table established.
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
 * True when the table is a two-across list of ENTITY NAMES — no jurisdiction column at all — so that reading its second
 * column as a jurisdiction would emit one company as another company's place of incorporation. The whole table
 * abstains.
 *
 * All three conditions are required over the table's two-value data rows: at least 4 of them, more than half of their
 * SECOND values carrying a legal designation, and more than 70% of those second values DISTINCT. `idt-2025.htm`'s
 * "Domestic Subsidiaries" table is 5 rows, 5/5 designated, 5 distinct.
 *
 * The distinctness condition is not belt-and-braces. Charter Communications writes its jurisdiction column as
 * `"Delaware limited liability company"`, so 135 of 135 second values carry a designation on a table that is a
 * perfectly ordinary name/jurisdiction list; what separates the two cases is repetition — a jurisdiction column repeats
 * (Charter 9 distinct over 135 rows, Comcast 0.05, Uniti 0.13, T-Mobile 0.15, Lumen 0.26), a second NAME column does
 * not (IDT 1.00). Measured 2026-08-03 across the large filings that are not vendored.
 */
const MINIMUM_NAME_OVER_NAME_ROWS = 4

/**
 * More than half the second values must carry a legal designation. IDT's two-across name table is 5/5; a genuine
 * jurisdiction column is 0/N except where the filer spells the entity type out (Charter's `"Delaware limited liability
 * company"`, 135/135) — which is what {@linkcode DISTINCT_SECOND_VALUE_RATIO} is there to separate.
 */
const DESIGNATED_SECOND_VALUE_RATIO = 0.5

/**
 * More than 70% of the second values must be DISTINCT. Measured 2026-08-03 over the large filings that are not
 * vendored: a jurisdiction column repeats (Charter 0.07, Comcast 0.05, Uniti 0.13, T-Mobile 0.15, Lumen 0.26), a second
 * NAME column does not (IDT 1.00). Drop this condition and Charter loses all 135 of its subsidiaries.
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
 * True when the table is a plain single-column list of names, in which a row holding exactly one value is a SUBSIDIARY
 * rather than a section heading. Every row must hold at most one value, and either two of them do (an actual list) or
 * the table is literally one cell wide (a one-row list has no heading to be confused with).
 *
 * The converse is what this rule exists for: a lone value in a table that ALSO has multi-value rows is a section
 * heading (`idt-2025.htm`'s "Domestic Subsidiaries") or a trailing explanatory sentence (its `"*Versature
 * Communications Corp. has registered Net2Phone Canada as a Trade Name"`, a one-row table three columns wide).
 */
const MINIMUM_NAME_LIST_ROWS = 2

function isSingleColumnNameList(rows: readonly TableCell[][], rawWidth: number): boolean {
	if (!rows.length) return false

	const valueCounts = rows.map((row) => row.filter((cell) => cell.text !== "").length)

	if (!valueCounts.every((count) => count <= 1)) return false

	return valueCounts.filter((count) => count === 1).length >= MINIMUM_NAME_LIST_ROWS || rawWidth === 1
}

/**
 * Turns ONE top-level table's extracted rows into subsidiaries, given the column mapping a PRECEDING sibling table
 * established (or `null`). Returns the mapping in force at the end so the caller can carry it to the next sibling — see
 * the module docstring's "table strategy" section for the full rule order.
 */
function subsidiariesFromTable(
	extractedRows: readonly TableCell[][],
	carriedMapping: ColumnMapping | null
): ParsedExhibit21 & { mapping: ColumnMapping | null } {
	const subsidiaries: ParsedSubsidiary[] = []
	let unparseable = 0

	// An empty <tr></tr> — formatting cruft, not a data row either way, and not a column's worth of evidence.
	const present = extractedRows.filter((row) => row.length > 0)
	const rawWidth = widestRow(present)
	const rows = padAndDropBlankColumns(present)
	const mapping = headerColumnMapping(rows, present) ?? carriedMapping

	if (!mapping && isNameOverNameTable(rows)) {
		return { subsidiaries, unparseable: rows.length, mapping }
	}

	const singleColumnList = isSingleColumnNameList(rows, rawWidth)

	for (const [rowIndex, row] of rows.entries()) {
		// A row made ENTIRELY of <th> cells — a header/label row, recognized and skipped (structural certainty).
		// Asked of the row as EXTRACTED: right-padding adds `<td>` blanks, which say nothing about the row's markup.
		if (present[rowIndex]!.every((cell) => cell.tag === "th")) continue

		const values = row.map((cell) => cell.text)
		const nonBlank = values.filter(isPresent)

		if (!nonBlank.length) {
			unparseable++

			continue
		}

		// A header/decoration row using <td> instead of <th> — recognized the same way, but COUNTED, since this
		// is a content judgment rather than markup certainty (decision 6: count a judgment call, don't discard it
		// for free).
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
				// An indented corporate tree: the child's name sits in a column to the RIGHT of the labelled name
				// column but still LEFT of the labelled jurisdiction column. The nesting depth is discarded (an
				// Exhibit 21 row is a registrant→subsidiary edge either way); the name itself is not in doubt,
				// because the header says the jurisdiction is to its right.
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

			// Otherwise FALL THROUGH to the generic rules rather than abstaining: a ragged table
			// (`anterix-2025.htm`'s 5- and 6-cell rows under a 6-cell header) misaligns the mapping without
			// making the row unreadable.
		}

		if (nonBlank.length > 2) {
			// An extra column this parser has no confident meaning for (an ownership percentage, an EIN) —
			// decision 6: abstain rather than guess which two of N columns are name/jurisdiction.
			unparseable++

			continue
		}

		if (!values[0]) {
			// A blank LEADING cell with no header mapping to explain it — an indented child row whose parent this
			// parser cannot identify, or a misaligned spacer. Decision 6 abstains.
			unparseable++

			continue
		}

		const [name, jurisdiction] = nonBlank as [string, string?]

		subsidiaries.push(jurisdiction ? { name, jurisdiction } : { name })
	}

	return { subsidiaries, unparseable, mapping }
}

/**
 * Classifies every top-level table in document order and concatenates the results, carrying each table's column mapping
 * forward to its siblings until another header row replaces it — EDGAR splits one logical table across page-break
 * tables constantly, and only the first carries the header (`att-2025.htm`'s second table holds AT&T Mobility, Cricket
 * Wireless, Teleport Communications America and BellSouth Telecommunications with no header of its own).
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
 * Narrows one raw EDGAR archive document to the markup every strategy below should reason about, applied ONCE in
 * {@linkcode parseExhibit21} so the table, list and plain-text strategies all see the same window rather than each
 * re-deriving it.
 *
 * The SGML `<TEXT>` element is EDGAR's own envelope around the exhibit; a document with no envelope (every hand-written
 * fixture in `exhibit21.test.ts`) is left whole. The HTML `<head>` goes because its `<title>` is the source filename
 * rather than a subsidiary — `q42025exh211listofsubsidia.htm` was emitted as an entity name before this window existed
 * — and `<script>`/`<style>` because their text is code.
 */
function documentWindow(html: string): string {
	return sliceDocument(html, { within: "text", without: ["head", "script", "style"] })
}

const LI_OPEN_PATTERN = /<li[^>]*>/gi
const LI_CHILD_BOUNDARY_PATTERN = /<ul[^>]*>|<ol[^>]*>|<li[^>]*>|<\/li>/i

/**
 * Extracts each `<li>`'s OWN text — the content up to (but not including) its first child `<ul>`/`<ol>`/`<li>`, or its
 * closing `</li>`, whichever comes first. This is what lets a NESTED subsidiary list flatten correctly without
 * balanced-tag tracking: scanning every `<li[^>]*>` open tag in document order and stopping each one's own text at its
 * first child element naturally separates a parent `<li>`'s own line from its nested `<ul>`'s own `<li>` children,
 * which this same scan also visits (later, since they appear later in the document). Returns `[]` when `html` has no
 * `<li>` tag at all (the caller falls through to the plain-text strategy).
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
 * Strips markup and splits into non-blank lines — the plain-text strategy's input prep. Whitespace inside a line is
 * deliberately NOT collapsed (unlike a table cell's text): a fixed-width plain-text Exhibit 21 uses a run of 2+ spaces
 * as its column separator, and {@linkcode splitCandidateLine} needs that run intact to find it.
 *
 * BLOCK-level element boundaries become real line breaks, so a minified document with no `\n` anywhere in it still
 * separates one paragraph per logical line. The layout reading is what makes that safe: two adjacent block boundaries
 * (`</p><p>`) are ONE separation, where a per-tag rewrite fabricates a second one.
 */
function extractPlainTextLines(html: string): string[] {
	const text = htmlToLayoutText(html, BLOCK_ELEMENTS)

	return text.split(/\r\n|\r|\n/).filter((line) => line.trim() !== "")
}

/**
 * True when `value` is JUST a corporate legal-entity suffix ("Inc.", "LLC", "Corp.") with nothing else —
 * `canonicalizeOrganizationName` (`@mailwoman/record`, already used the same way by `edgar-filings.ts`) reduces such a
 * string to an empty canonical name and a non-empty `designations` list. Guards {@linkcode splitCandidateLine}'s
 * single-comma rule: a bare designation immediately after a comma is the tail of ONE entity's name (`"Horizon Services,
 * Inc."`), not a jurisdiction, and the comma rule must not treat "Inc." as if it were a place.
 *
 * @todo Move to `@mailwoman/record/organization`
 */
function isBareLegalDesignation(value: string): boolean {
	const canonicalized = canonicalizeOrganizationName(value)

	return canonicalized !== null && canonicalized.canonical === "" && canonicalized.designations.length > 0
}

/**
 * The fixed-width column separator: a run of two or more spaces or tabs. U+00A0 counts, because `&nbsp;` and `&#160;`
 * are the same character and a filer that writes its gap in either spelling states the same column.
 */
const COLUMN_GAP_PATTERN = /[ \t\u00A0]{2,}/

/**
 * Splits one candidate line (a plain-text row, or one `<li>`'s own text) into a name and an optional jurisdiction — see
 * the module docstring's "list/plain-text strategies" section for why this only ever abstains on the JURISDICTION,
 * never the name. Tried in order:
 *
 * 1. A 2+-space (or tab) column gap — the fixed-width plain-text convention.
 * 2. A trailing `(Jurisdiction)` parenthetical — the common nested-list-item convention.
 * 3. EXACTLY one comma — `"Acme Fiber LLC, Delaware"`. Zero or 2+ commas is NOT split this way (a legal name can itself
 *    contain a comma, e.g. `"Acme Fiber, LLC"`, so 2+ commas is genuinely ambiguous about where the name ends) —
 *    decision 6 abstains from the split, not from recording the line. Nor is a single comma split when the text after
 *    it is JUST a corporate designator (`{@linkcode isBareLegalDesignation}` — `canonicalizeOrganizationName` reduces
 *    `"Inc."` to an empty canonical name) — `"Horizon Services, Inc."` is one entity's whole legal name, and "Inc." is
 *    not a place a comma could plausibly be introducing.
 *
 * Falls through to `{name: <the whole cleaned line>}` when none of the above apply — an honest "no jurisdiction found",
 * never a fabricated one. The one exception is a 3+-column 2+-space-gap split (`name jurisdiction 100%`): that's an
 * extra column this parser has no confident meaning for, the same shape {@linkcode subsidiariesFromTableRows} abstains
 * on for a 3+-cell table row, and it returns a blank name (counted `unparseable` by the caller) rather than falling
 * through to concatenating all 3+ columns into one fabricated name.
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
 * A leading bullet or list-marker glyph — markup convention, not part of a name. Stripped from a candidate line BEFORE
 * the name/jurisdiction split runs (module docstring, "Line/list refinements"): `"• Bandwidth.com CLEC, LLC (Delaware,
 * United States)"` must become `"Bandwidth.com CLEC, LLC (Delaware, United States)"` before
 * {@linkcode splitCandidateLine} ever sees the (fabricated, tag-stripping-artifact) 2+-space gap the bullet leaves
 * behind — otherwise the trailing-parenthetical rule never gets a chance and the bullet itself is read as the name.
 */
const LIST_MARKER_PATTERN = /^[•●▪◦∙·*–—-]+\s*/

/**
 * Whole-line, case-insensitive shapes that are a document title or section heading, never an entity name — see the
 * module docstring's "Line/list refinements" paragraph. Deliberately whole-string patterns, not keyword sniffing, for
 * the same reason `KNOWN_HEADER_LABELS` (`exhibit21-vocabulary.ts`) is an exact-match set: substring sniffing on
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
 * A candidate line/list-item longer than this many whitespace-separated tokens is abstained on rather than split — see
 * the module docstring. The longest legitimate name in the real-filing corpus (`bandwidth-2025.htm`'s `"Voxbone
 * Telekomunikasyon ve Iletisim Hizmetleri Ticaret Limited Sirketi"`) is 8 tokens; a preamble sentence or a run of
 * concatenated names is not a name at all, and decision 6 abstains rather than guessing a boundary.
 */
const MAX_ENTITY_NAME_WORDS = 12

/**
 * Shared by the list and plain-text strategies: strip a leading list marker, abstain on a title/heading line or a line
 * too long to be one name, split every remaining candidate line, count a blank result as `unparseable` (the only
 * abstention these two strategies ever make on the NAME — see the module docstring), apply the same
 * header/decoration-row check the table strategy uses (a plain-text or `<li>` document has no `<th>` markup to lean on,
 * so its boilerplate title/column-header lines need the same content-based recognition), and keep the rest.
 *
 * A line reduced to nothing but whitespace by the marker strip falls through to {@linkcode splitCandidateLine} same as
 * any other line — it still ends up counted `unparseable` there (a blank name), the same basis `"----"`-style
 * decorative divider lines were already counted on before this rule existed; that path is preserved deliberately rather
 * than special-cased to "skip uncounted", since the marker character class overlaps with plain decorative dashes and
 * the two cases aren't distinguishable from the marker alone.
 */
function subsidiariesFromLines(lines: readonly string[]): ParsedExhibit21 {
	const subsidiaries: ParsedSubsidiary[] = []
	let unparseable = 0

	for (const line of lines) {
		const unmarked = line.replace(LIST_MARKER_PATTERN, "")

		const wordCount = unmarked
			.trim()
			.split(/\s+/)
			.filter((value) => value.length > 0).length

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
 * True when every extracted cell of every extracted row is blank — a purely decorative border/spacer table (the kind
 * Word/Workiva exports use as a horizontal-rule substitute) carrying no subsidiary data at all, as opposed to a real
 * table that legitimately abstains on some or all of its rows (`subsidiariesFromTableRows`'s job, unchanged here).
 * `shentel-2025.htm` states its subsidiary list as block text OUTSIDE two such decorative tables; committing to the
 * (empty) table strategy the instant ANY `<table>` tag exists would silence the real list this document states. A table
 * with even one real non-blank cell still commits to the table strategy as before — reading a REAL table's data with
 * more confidence (multiple sibling tables, blank spacer columns, footnote rows, …) is Task 3's territory, not this
 * check's.
 */
function isEntirelyBlankTable(tables: readonly TableCell[][][]): boolean {
	return tables.every((rows) => rows.every((row) => row.every((cell) => cell.text === "")))
}

/**
 * Parses an Exhibit 21 document into its subsidiary list. Decision 6 binds: a row/line that cannot be confidently
 * extracted is counted (`unparseable`) and dropped, never guessed at — this function NEVER throws on malformed input
 * (criterion 3); the worst case for a document this parser cannot make sense of at all is `{subsidiaries: [],
 * unparseable: N}`.
 *
 * Runs {@linkcode documentWindow} once, first — every strategy below reasons about the same window, never the raw
 * archive document with its SGML envelope still attached.
 *
 * Tries three shapes, in order, and commits to the FIRST one it detects (a real Exhibit 21 uses one consistent format
 * throughout, so there's no ambiguity in picking the first match rather than trying all three and merging):
 *
 * 1. An HTML `<table>` — the common modern shape. A table every one of whose cells is blank
 *    ({@linkcode isEntirelyBlankTable}) is treated as no table at all and falls through to shape 2/3 instead.
 * 2. A `<li>`-based list (nested subsidiary trees included, flattened) — see {@linkcode extractListItemOwnText}'s
 *    docstring for how nesting is handled without a real HTML parser.
 * 3. Plain fixed-width text (no recognized markup at all) — the older SGML-era shape.
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
 * The slice of `SECClient` (`sec-client.ts`) this module needs — {@linkcode fetchExhibit21} takes this rather than the
 * concrete class so a test can substitute a trivial stub instead of building a full axios harness. A real
 * `createSECClient()` instance already satisfies this structurally.
 */
export interface SECDocumentClient {
	getDocument(input: string | URL): Promise<string>
}

/**
 * Fetches one Exhibit 21 document (through the shared SEC client's `getDocument` raw-text path) and parses it.
 * Discovering WHICH URL a filing's Exhibit 21 lives at is out of scope here — the caller supplies it (from the filing's
 * own archive index, however that's found).
 *
 * @todo Move this to a {@linkcode SECDocumentClient} method.
 */
export async function fetchExhibit21(client: SECDocumentClient, url: string | URL): Promise<ParsedExhibit21> {
	const html = await client.getDocument(url)

	return parseExhibit21(html)
}
