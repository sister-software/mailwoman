/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Conservative SEC Exhibit 21 subsidiary parser.
 *
 * Recognizes measured table, list, and plain-text filing shapes and counts uncertain rows instead of inventing entities.
 * See `exhibit21-parser.md` for the parsing contract and abstention rules.
 */

import { isPresent } from "@mailwoman/core/objects"
import { canonicalizeOrganizationName } from "@mailwoman/record"

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
 * {@linkcode parseExhibit21}'s result. `unparseable` is a COUNT, not a list of the offending text — gate 3 only requires
 * knowing abstention happened and how often, not what was abstained from.
 */
export interface ParsedExhibit21 {
	subsidiaries: ParsedSubsidiary[]
	/**
	 * Rows/lines this parser recognized as an ENTRY (a table data row, a list item, a non-blank text line) but could not
	 * confidently reduce to a subsidiary name — decision 6: counted and dropped, never guessed at, and never thrown as an
	 * error either (gate 3).
	 */
	unparseable: number
}

const SGML_TEXT_OPEN = /<TEXT>/i
const SGML_TEXT_CLOSE = /<\/TEXT>/i
const HEAD_BLOCK = /<head[^>]*>[\s\S]*?<\/head>/gi
const SCRIPT_OR_STYLE_BLOCK = /<(script|style)[^>]*>[\s\S]*?<\/\1>/gi

/**
 * Slices a raw EDGAR archive document down to what every strategy below should reason about — see the module
 * docstring's "Document window" paragraph. Applied ONCE, first thing, in {@linkcode parseExhibit21}, so the table, list
 * and plain-text strategies all see the same window rather than each re-deriving it (and Task 3's table strategy
 * consumes it directly).
 *
 * Slices to the SGML `<TEXT>...</TEXT>` payload (falling back to the whole input when either boundary is missing — a
 * document with no SGML envelope, e.g. every hand-written fixture in `exhibit21.test.ts`, is unaffected), then strips
 * the HTML `<head>` block (whose `<title>` is the source filename, not a subsidiary) and any `<script>`/ `<style>`
 * blocks.
 */
export function documentWindow(html: string): string {
	const open = SGML_TEXT_OPEN.exec(html)
	const afterOpen = open ? html.slice(open.index + open[0].length) : html
	const close = SGML_TEXT_CLOSE.exec(afterOpen)
	const body = close ? afterOpen.slice(0, close.index) : afterOpen

	return body.replaceAll(HEAD_BLOCK, "").replaceAll(SCRIPT_OR_STYLE_BLOCK, "")
}

const TAG_PATTERN = /<[^>]*>/g

/**
 * Strips every tag, replacing each with a separating space ONLY when the source doesn't already have adjacent
 * whitespace — otherwise strips to nothing. A naive "always replace with a space" turns two back-to-back tags with
 * nothing between them (`</p><p>`, or `</b>` immediately followed by a real source space) into a fabricated 2+-space
 * run, which downstream column-splitting would mistake for an intentional fixed-width gap. See the module docstring's
 * tag-stripping paragraph for the two concrete failure cases this avoids.
 *
 * Exported (alongside {@linkcode decodeEntities}/{@linkcode normalizeWhitespace}) so `exhibit21.test.ts`'s
 * substring-invariant test can compute the same "normalized input" this module reasons about — see the module
 * docstring's invariant paragraph.
 */
export function stripTags(html: string): string {
	return html.replaceAll(TAG_PATTERN, (match: string, offset: number, whole: string) => {
		const before = whole[offset - 1]
		const after = whole[offset + match.length]

		const hasAdjacentWhitespace =
			(before !== undefined && /\s/.test(before)) || (after !== undefined && /\s/.test(after))

		return hasAdjacentWhitespace ? "" : " "
	})
}

const NAMED_HTML_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
}

const ENTITY_PATTERN = /&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi

/**
 * Decodes the handful of named entities Exhibit 21 documents actually use, plus numeric/hex character references.
 * Deliberately not exhaustive (no full HTML5 entity table) — matches this file's "no HTML-parser dependency" scope.
 */
export function decodeEntities(text: string): string {
	return text.replaceAll(ENTITY_PATTERN, (whole, code: string) => {
		if (code.startsWith("#")) {
			const codepoint =
				code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10)

			return Number.isFinite(codepoint) ? String.fromCodePoint(codepoint) : whole
		}

		const lower = code.toLowerCase()

		return lower in NAMED_HTML_ENTITIES ? NAMED_HTML_ENTITIES[lower]! : whole
	})
}

export function normalizeWhitespace(text: string): string {
	return text.replaceAll(/\s+/g, " ").trim()
}

/**
 * Cleans one TABLE CELL's raw inner HTML into comparable text: strip any stray inline tags, decode entities, collapse
 * whitespace, trim. Table cells are already column-separated by markup, so (unlike plain-text/list lines) there is no
 * fixed-width spacing worth preserving.
 */
function cleanCellText(rawHTML: string): string {
	return normalizeWhitespace(decodeEntities(stripTags(rawHTML)))
}

interface TableCell {
	tag: "td" | "th"
	text: string
	/**
	 * The cell's RAW inner HTML, kept alongside the cleaned {@linkcode TableCell.text} because
	 * {@linkcode isMultiValueCell} needs the block structure `text` has already thrown away — a `<td>` holding five `<p>`
	 * blocks cleans to one run-on string indistinguishable from a genuinely long name.
	 */
	rawHTML: string
}

const BLANK_CELL: TableCell = { tag: "td", text: "", rawHTML: "" }

const ROW_PATTERN = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
const CELL_START_PATTERN = /<t([dh])[^>]*>/gi
const TABLE_TAG_PATTERN = /<table[^>]*>|<\/table>/gi

/**
 * Finds EVERY top-level (depth-0) `<table>...</table>` block in `html`, in document order — depth-tracked, so a nested
 * layout/formatting table belongs to the cell it sits in and is never returned as a table of its own. A final top-level
 * `<table>` missing its `</table>` (truncated/malformed markup) still yields everything after its opening tag.
 *
 * Reading only the outermost table (the previous approach) is the single largest recall defect the real corpus exposed:
 * EDGAR splits one logical subsidiary list across sibling page-break tables constantly — `att-2025.htm` uses 2,
 * `echostar-2025.htm` 5, `atn-international-2025.htm` 7, and the unvendored Comcast filing 33 — and only the first
 * carries a header row.
 */
function extractTopLevelTableHTML(html: string): string[] {
	const tables: string[] = []

	let depth = 0
	let contentStart = -1

	for (const match of html.matchAll(TABLE_TAG_PATTERN)) {
		if (match[0]!.toLowerCase().startsWith("<table")) {
			if (depth === 0) {
				contentStart = match.index + match[0].length
			}

			depth++
		} else if (depth > 0) {
			depth--

			if (depth === 0) {
				tables.push(html.slice(contentStart, match.index))

				contentStart = -1
			}
		}
	}

	if (depth > 0 && contentStart !== -1) {
		tables.push(html.slice(contentStart))
	}

	return tables
}

/**
 * Extracts one `<tr>` row's cells by slicing between successive `<td>`/`<th>` START tags — NOT by matching each cell up
 * to its own closing tag. Word-exported EDGAR HTML routinely leaves `<td>` unclosed; requiring a matching `</t[dh]>`
 * (the previous approach) makes an unclosed cell's match run on to the NEXT cell's closing tag, silently merging two
 * cells' text into one fabricated name. Slicing on start-tag boundaries instead treats an unclosed `<td>` exactly as a
 * browser would: implicitly closed by the next `<td>`/`<th>`, or by the row's end when there is no later cell. A
 * trailing `</td>`/`</th>`, if present, is just another stray tag `cleanCellText` strips.
 */
function extractRowCells(rowHTML: string): TableCell[] {
	const starts: Array<{ tag: "td" | "th"; index: number; contentStart: number }> = []

	for (const match of rowHTML.matchAll(CELL_START_PATTERN)) {
		starts.push({
			tag: match[1]!.toLowerCase() === "h" ? "th" : "td",
			index: match.index,
			contentStart: match.index + match[0].length,
		})
	}

	return starts.map((start, i) => {
		const end = i + 1 < starts.length ? starts[i + 1]!.index : rowHTML.length
		const rawHTML = rowHTML.slice(start.contentStart, end)

		return { tag: start.tag, text: cleanCellText(rawHTML), rawHTML }
	})
}

/**
 * Extracts every top-level table's `<tr>` rows' cells from `html`, or `null` when there is no table at all (the caller
 * falls through to the list/plain-text strategies). A row is `[]` when it has no `<td>`/`<th>` cells at all (formatting
 * cruft — an empty `<tr></tr>`), never `null`.
 */
function extractTableRows(html: string): TableCell[][][] | null {
	const tables = extractTopLevelTableHTML(html)

	if (!tables.length) return null

	return tables.map((tableHTML) => {
		const rows: TableCell[][] = []

		for (const rowMatch of tableHTML.matchAll(ROW_PATTERN)) {
			rows.push(extractRowCells(rowMatch[1]!))
		}

		return rows
	})
}

/**
 * Right-pads every row to the table's widest row, then drops each column index that is blank in EVERY row. Per table,
 * and column-wise — never per row. A row-by-row "filter out the blanks" loses the fact that a row's LEADING cell was
 * blank, which is the difference between a top-level subsidiary row and an indented child row, and no single row
 * carries enough evidence to tell those apart.
 *
 * This is what an all-blank spacer column costs when it isn't dropped: `cable-one-2025.htm`, `ooma-2025.htm`,
 * `verizon-2025.htm`, `att-2025.htm` and `anterix-2025.htm` all interleave one, making every data row look 3-wide (the
 * shape the 3+-column rule abstains on) and yielding zero subsidiaries each.
 */
function widestRow(rows: readonly TableCell[][]): number {
	let width = 0

	for (const row of rows) {
		width = Math.max(width, row.length)
	}

	return width
}

function padAndDropBlankColumns(rows: readonly TableCell[][]): TableCell[][] {
	const width = widestRow(rows)
	const keep: number[] = []

	for (let column = 0; column < width; column++) {
		if (rows.some((row) => (row[column]?.text ?? "") !== "")) {
			keep.push(column)
		}
	}

	return rows.map((row) => keep.map((column) => row[column] ?? BLANK_CELL))
}

const DECORATIVE_ONLY_PATTERN = /^[^a-z0-9]*$/i

/**
 * Column labels that name a JURISDICTION column. Exactly one of these in a header row is what licenses
 * {@linkcode headerColumnMapping} — the document says which column means what, so reading it is not guessing.
 */
const JURISDICTION_HEADER_LABELS = new Set<string>([
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
 * percentage, a tax ID. {@linkcode headerColumnMapping} skips these when picking the name column, and every one of them
 * is also a header label in its own right.
 */
const OTHER_HEADER_LABELS = new Set<string>([
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

const KNOWN_HEADER_LABELS = new Set<string>([
	...JURISDICTION_HEADER_LABELS,
	...OTHER_HEADER_LABELS,
	...NAME_HEADER_LABELS,
])

/**
 * Recognizes a row/line as a document HEADER or pure-decoration row rather than a data row — see the module docstring's
 * table-strategy paragraph for why this is deliberately NOT substring/keyword sniffing (which would misfire on a
 * company literally named e.g. "Subsidiary Holdings LLC"). Two narrow checks, both applied to every non-blank value:
 * pure decoration (no letter or digit anywhere in it — `"----"`, `"======="` — which no legal entity name can be), or
 * an EXACT case-insensitive match against a short fixed list of the literal boilerplate phrases EDGAR Exhibit 21
 * filings actually use. All-blank input is NOT a header/decoration row (that's the pre-existing empty-row/blank-name
 * handling's job, not this one's).
 */
function isHeaderOrDecorationRow(values: readonly string[]): boolean {
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
const FOOTNOTE_MARKER_PATTERN = /^[([]?\d{1,3}[)\]]?$|^\*{1,3}$/

/**
 * Block-level boundaries inside ONE cell's raw HTML. See {@linkcode isMultiValueCell}.
 */
const CELL_BLOCK_BOUNDARY_PATTERN = /<\/p\s*>|<\/div\s*>|<br[^>]*>|<\/li\s*>/gi

const LETTER_OR_DIGIT_PATTERN = /[a-z0-9]/i

/**
 * True when `value` carries a corporate legal designation ("Inc.", "LLC", "Limited") — `canonicalizeOrganizationName`
 * (`@mailwoman/record`) returns a non-empty `designations` array exactly then. Verified against the corpus on
 * 2026-08-03: `"IDT Payment Services, Inc*. (DE)"` → `["inc"]`, while `"South Carolina"`, `"Delaware"`, `"British
 * Columbia, Canada"`, `"England and Wales"` and `"DE"` all → `[]`. Used by {@linkcode isMultiValueCell} and
 * {@linkcode isNameOverNameTable} to tell an entity name from a place — never on its own, always alongside a second
 * condition, because a jurisdiction CAN carry one (Charter writes `"Delaware limited liability company"`).
 */
function carriesLegalDesignation(value: string): boolean {
	return (canonicalizeOrganizationName(value)?.designations.length ?? 0) > 0
}

/**
 * True when ONE cell holds several ENTITY VALUES the source kept in separate blocks — a block boundary (`</p>`,
 * `</div>`, `<br>`, `</li>`) with a COMPLETE legal entity name on both sides of it. `ooma-2025.htm`'s last row is a
 * single `<td>` holding five `<p>` blocks; cleaning it to text runs them together into `"Trunking.IO, LLC FluentStream
 * Corp. FluentStream Intermediate, LLC …"` against a jurisdiction of `"Delaware Delaware Delaware Colorado Delaware"`,
 * which is five fabricated claims, not one. Decision 6: the row states more than this parser can align, so it
 * abstains.
 *
 * A block boundary alone is NOT enough, and this is the rule's whole difficulty: EDGAR's Word/Workiva exporters also
 * emit a SOFT LINE WRAP as a block boundary, so `att-2025.htm` states one name as `<div>Illinois Bell
 * Telephone</div><div>&#160;&#160;Company, LLC</div>` — text on both sides, one entity. What separates the two is that
 * each half of a genuine multi-value cell is a whole legal name carrying its own designation
 * (`canonicalizeOrganizationName` — `"Trunking.IO, LLC"` / `"FluentStream Corp. …"` both do), whereas a wrap splits ONE
 * name's designation off the front half (`"Illinois Bell Telephone"` carries none). Ten of AT&T's nineteen subsidiaries
 * are stated on wrapped rows.
 */
function isMultiValueCell(rawHTML: string): boolean {
	for (const match of rawHTML.matchAll(CELL_BLOCK_BOUNDARY_PATTERN)) {
		const before = cleanCellText(rawHTML.slice(0, match.index))
		const after = cleanCellText(rawHTML.slice(match.index + match[0].length))

		if (!LETTER_OR_DIGIT_PATTERN.test(before) || !LETTER_OR_DIGIT_PATTERN.test(after)) continue

		if (carriesLegalDesignation(before) && carriesLegalDesignation(after)) return true
	}

	return false
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
 * is unreadable and must stay unreadable (gate 3's required fixture asserts zero subsidiaries from it).
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

		if (isMultiValueCell(leadCell.rawHTML)) {
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
		const ownText = decodeEntities(stripTags(ownHTML))

		if (ownText.trim()) {
			lines.push(ownText)
		}
	}

	return lines
}

const BLOCK_BREAK_PATTERN =
	/<\/?(?:p|div|tr|td|th|li|ul|ol|table|thead|tbody|tfoot|br|hr|h[1-6]|section|article|header|footer|blockquote|pre|html|body|head|title)(?:\s[^>]*)?>/gi

/**
 * Strips any stray markup, decodes entities, and splits into non-blank lines — the plain-text strategy's input prep.
 * Whitespace is deliberately NOT collapsed here (unlike {@linkcode cleanCellText}): a fixed-width plain-text Exhibit 21
 * uses a run of 2+ spaces as its column separator, and {@linkcode splitCandidateLine} needs that run intact to find
 * it.
 *
 * KNOWN BLOCK-level tag boundaries are rewritten to a real line break BEFORE the remaining tags are stripped: a
 * minified document (no real `\n` at all) still separates one paragraph/row per logical line this way. Skipping this
 * step would let `stripTags`' single space per tag concatenate every paragraph onto one line — and worse, two adjacent
 * block tags with nothing between them (`</p><p>`) would fabricate a false 2+-space "column gap" between two
 * otherwise-unrelated paragraphs. See the module docstring's tag-stripping paragraph.
 */
function extractPlainTextLines(html: string): string[] {
	const withLineBreaks = html.replaceAll(BLOCK_BREAK_PATTERN, "\n")
	const text = decodeEntities(stripTags(withLineBreaks))

	return text.split(/\r\n|\r|\n/).filter((line) => line.trim() !== "")
}

/**
 * True when `value` is JUST a corporate legal-entity suffix ("Inc.", "LLC", "Corp.") with nothing else —
 * `canonicalizeOrganizationName` (`@mailwoman/record`, already used the same way by `edgar-filings.ts`) reduces such a
 * string to an empty canonical name and a non-empty `designations` list. Guards {@linkcode splitCandidateLine}'s
 * single-comma rule: a bare designation immediately after a comma is the tail of ONE entity's name (`"Horizon Services,
 * Inc."`), not a jurisdiction, and the comma rule must not treat "Inc." as if it were a place.
 */
function isBareLegalDesignation(value: string): boolean {
	const canonicalized = canonicalizeOrganizationName(value)

	return canonicalized !== null && canonicalized.canonical === "" && canonicalized.designations.length > 0
}

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
		.split(/[ \t]{2,}/)
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
 * the same reason `KNOWN_HEADER_LABELS` is an exact-match set: substring sniffing on "subsidiaries" would misfire on a
 * company actually named that.
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
 * (gate 3); the worst case for a document this parser cannot make sense of at all is `{subsidiaries: [], unparseable:
 * N}`.
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
 */
export async function fetchExhibit21(client: SECDocumentClient, url: string | URL): Promise<ParsedExhibit21> {
	const html = await client.getDocument(url)

	return parseExhibit21(html)
}
