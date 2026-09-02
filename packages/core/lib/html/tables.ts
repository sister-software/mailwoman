/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Conservative SGML/HTML table machinery, extracted from the SEC Exhibit 21 parser (2026-09) where it
 *   lived behind the comment this module now fulfils: the parser's own @deprecated notes named
 *   @mailwoman/core/html/tables as this home.
 */

import { isPresent } from "@mailwoman/core/objects"
import { stripHTMLToText } from "@mailwoman/core/trust-policies"
import { canonicalizeOrganizationName } from "@mailwoman/record"

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
 *
 * The table-cell path takes the shared DOM-backed extraction (`stripHTMLToText`) instead; this stays for the
 * fixed-width plain-text and list strategies, whose column logic depends on the boundary-spacing rule above — a DOM
 * reading concatenates adjacent block texts with nothing between them.
 *
 * TODO: Swap out with isomorphic-dompurify via `@mailwoman/core/trust-policies`
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
 * Serves the fixed-width plain-text and list strategies beside {@linkcode stripTags}; the table-cell path decodes the
 * full entity set through the shared sanitizer instead.
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

/**
 * @deprecated use or define in `@mailwoman/core/strings/etc...`
 */
export function normalizeWhitespace(text: string): string {
	return text.replaceAll(/\s+/g, " ").trim()
}

/**
 * Cleans one TABLE CELL's raw inner HTML into comparable text: tags gone, entities decoded (the full set, through the
 * shared sanitizer), whitespace collapsed, trimmed. Table cells are already column-separated by markup, so (unlike
 * plain-text/list lines) there is no fixed-width spacing worth preserving — which is why the cell path can take the
 * DOM-backed extraction while the fixed-width strategies keep {@linkcode stripTags}.
 *
 * @deprecated use or define in `@mailwoman/core/strings/etc...`
 */
export function cleanCellText(rawHTML: string): string {
	return normalizeWhitespace(stripHTMLToText(rawHTML))
}

export interface TableCell {
	tag: "td" | "th"
	text: string
	/**
	 * The cell's RAW inner HTML, kept alongside the cleaned {@linkcode TableCell.text} because
	 * {@linkcode isMultiValueCell} needs the block structure `text` has already thrown away — a `<td>` holding five `<p>`
	 * blocks cleans to one run-on string indistinguishable from a genuinely long name.
	 */
	rawHTML: string
}

/**
 * The empty table cell used to pad rows to a uniform width.
 *
 * Moved from the SEC Exhibit 21 parser (2026-09). It was a module-local constant there.
 */
export const BLANK_CELL: TableCell = { tag: "td", text: "", rawHTML: "" }

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
 *
 * @deprecated Move to `@mailwoman/core/html/tables` and use a DOM parser to read the table structure.
 * @todo In desperate need of `htmlparser2`'s ecosystem. Extract repeatable aspects into `@mailwoman/core/html/tables`
 *   and keep what remains here, if anything at all.
 */
export function extractTopLevelTableHTML(html: string): string[] {
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
 *
 * @deprecated Move to `@mailwoman/core/html/tables` and use a DOM parser to read the table structure.
 * @todo In desperate need of `htmlparser2`'s ecosystem. Extract repeatable aspects into `@mailwoman/core/html/tables`
 *   and keep what remains here, if anything at all.
 */
export function extractRowCells(rowHTML: string): TableCell[] {
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
 *
 * @deprecated Move to `@mailwoman/core/html/tables` and use a DOM parser to read the table structure.
 * @todo In desperate need of `htmlparser2`'s ecosystem. Extract repeatable aspects into `@mailwoman/core/html/tables`
 *   and keep what remains here, if anything at all.
 */
export function extractTableRows(html: string): TableCell[][][] | null {
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
 *
 * @deprecated Move to `@mailwoman/core/html/tables` and use a DOM parser to read the table structure.
 * @todo In desperate need of `htmlparser2`'s ecosystem. Extract repeatable aspects into `@mailwoman/core/html/tables`
 *   and keep what remains here, if anything at all.
 */
export function widestRow(rows: readonly TableCell[][]): number {
	let width = 0

	for (const row of rows) {
		width = Math.max(width, row.length)
	}

	return width
}

/**
 * @deprecated Move to `@mailwoman/core/html/tables` and use a DOM parser to read the table structure.
 * @todo In desperate need of `htmlparser2`'s ecosystem. Extract repeatable aspects into `@mailwoman/core/html/tables`
 *   and keep what remains here, if anything at all.
 */
export function padAndDropBlankColumns(rows: readonly TableCell[][]): TableCell[][] {
	const width = widestRow(rows)
	const keep: number[] = []

	for (let column = 0; column < width; column++) {
		if (rows.some((row) => (row[column]?.text ?? "") !== "")) {
			keep.push(column)
		}
	}

	return rows.map((row) => keep.map((column) => row[column] ?? BLANK_CELL))
}

/**
 * Matches a cell value made only of punctuation and whitespace.
 *
 * Moved from the SEC Exhibit 21 parser (2026-09). It classified decorative header rows.
 */
export const DECORATIVE_ONLY_PATTERN = /^[^a-z0-9]*$/i

/**
 * Column labels that name a JURISDICTION column. Exactly one of these in a header row is what licenses
 * {@linkcode headerColumnMapping} — the document says which column means what, so reading it is not guessing.
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
 * percentage, a tax ID. {@linkcode headerColumnMapping} skips these when picking the name column, and every one of them
 * is also a header label in its own right.
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
export const NAME_HEADER_LABELS = new Set<string>([
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
 *
 * Moved from the SEC Exhibit 21 parser (2026-09). It was built from the same sets.
 */
export const KNOWN_HEADER_LABELS = new Set<string>([
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
 * Block-level boundaries inside ONE cell's raw HTML. See {@linkcode isMultiValueCell}.
 */
export const CELL_BLOCK_BOUNDARY_PATTERN = /<\/p\s*>|<\/div\s*>|<br[^>]*>|<\/li\s*>/gi

/**
 * Matches any letter or digit.
 *
 * Moved from the SEC Exhibit 21 parser (2026-09). It tests whether a value carries real text.
 */
export const LETTER_OR_DIGIT_PATTERN = /[a-z0-9]/i

/**
 * True when `value` carries a corporate legal designation ("Inc.", "LLC", "Limited") — `canonicalizeOrganizationName`
 * (`@mailwoman/record`) returns a non-empty `designations` array exactly then. Verified against the corpus on
 * 2026-08-03: `"IDT Payment Services, Inc*. (DE)"` → `["inc"]`, while `"South Carolina"`, `"Delaware"`, `"British
 * Columbia, Canada"`, `"England and Wales"` and `"DE"` all → `[]`. Used by {@linkcode isMultiValueCell} and
 * {@linkcode isNameOverNameTable} to tell an entity name from a place — never on its own, always alongside a second
 * condition, because a jurisdiction CAN carry one (Charter writes `"Delaware limited liability company"`).
 */
export function carriesLegalDesignation(value: string): boolean {
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
export function isMultiValueCell(rawHTML: string): boolean {
	for (const match of rawHTML.matchAll(CELL_BLOCK_BOUNDARY_PATTERN)) {
		const before = cleanCellText(rawHTML.slice(0, match.index))
		const after = cleanCellText(rawHTML.slice(match.index + match[0].length))

		if (!LETTER_OR_DIGIT_PATTERN.test(before) || !LETTER_OR_DIGIT_PATTERN.test(after)) continue

		if (carriesLegalDesignation(before) && carriesLegalDesignation(after)) return true
	}

	return false
}
