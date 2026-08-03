/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Exhibit 21 ("Subsidiaries of the Registrant") fetch + parse (decision 6, gate 3).
 *
 *   Exhibit 21 is genuinely inconsistent across filers: some file a clean HTML `<table>`, some a nested
 *   `<ul>`/`<li>` corporate tree, some a plain fixed-width-column text block (the older SGML-era filings),
 *   and plenty are simply malformed in ways none of the above recognize. {@linkcode parseExhibit21} tries
 *   exactly three recognized shapes, in order — table, then nested list, then plain text — and DECISION 6
 *   BINDS on every one of them: a row/line this parser cannot confidently reduce to a subsidiary name (and
 *   optional jurisdiction) is COUNTED as `unparseable` and DROPPED, never guessed at. Gate 3 lives here and
 *   is load-bearing: a mangled fixture yields zero subsidiaries, a non-zero `unparseable`, and no thrown
 *   error; a clean fixture yields exactly the expected list.
 *
 *   **The invariant: a name is only emitted if it appears in the input as a contiguous string.** Every
 *   `ParsedSubsidiary.name`/`.jurisdiction` this module emits must be a substring of the document once tags
 *   are stripped, entities decoded, and whitespace collapsed — never text assembled by joining two things
 *   the source kept apart, and never text truncated at a boundary the source didn't put there. Concatenating
 *   an unclosed cell into its neighbor, pairing two unrelated lines as name/jurisdiction, and splitting a
 *   name in half at an inline tag's artifact space are all violations of this invariant, not merely of
 *   decision 6 — they fabricate a claim ("this string names a subsidiary") the input never made. It's
 *   directly testable (`exhibit21.test.ts`'s substring-invariant test asserts it across every fixture) and
 *   is the standard every extraction strategy below is held to.
 *
 *   **No HTML-parser dependency.** This workspace has none (`@mailwoman/filer`'s only runtime deps are
 *   `@mailwoman/*` workspaces + kysely + type-fest — see `form499.ts`/`provider-list.ts` for the identical
 *   hand-rolled-parser precedent), and Exhibit 21's known shapes don't need one. Table/list extraction below
 *   is a small, deliberately narrow regex-based scan — not a general HTML parser, and not trying to be one.
 *
 *   **Table strategy.** The table used is the OUTERMOST `<table>...</table>` in the document (depth-tracked,
 *   not "up to the first `</table>`") — a nested layout/formatting table inside a cell must not truncate the
 *   scan before the real subsidiary rows that follow it. A row's cells are found by slicing between
 *   successive `<td>`/`<th>` START tags rather than requiring a matching close tag: Word-exported EDGAR HTML
 *   routinely leaves `<td>` unclosed, and a browser (and this parser) treats that as implicitly closed by
 *   the next cell or the row's end, not as one cell whose text runs on into its neighbor's.
 *
 *   A row made ENTIRELY of `<th>` cells is recognized as a header/label row and skipped (neither counted as
 *   a subsidiary nor as `unparseable`) — this is unambiguous given well-formed markup. A row is also
 *   recognized as a header/decoration row — same skip, but COUNTED as `unparseable`, since this is a content
 *   judgment rather than markup certainty — when every non-blank cell is either pure decoration (no letter
 *   or digit anywhere in it, e.g. `"----"`) or an EXACT case-insensitive match against a short fixed list of
 *   the literal boilerplate phrases EDGAR filings use (`"name of subsidiary"`, `"jurisdiction of
 *   incorporation"`, `"subsidiaries of the registrant"`, …). This is deliberately NOT substring/keyword
 *   sniffing on words like "subsidiary" or "jurisdiction" — that would misfire on a company literally named
 *   that — it's an exact whole-cell match against known non-entity boilerplate text, which a real legal
 *   entity name does not collide with.
 *
 *   A data row with exactly 1 or 2 non-empty cells is confident (`{name}` or `{name, jurisdiction}`); a row
 *   with 0 cells is silently ignored as formatting cruft (an empty `<tr></tr>`); a row with a BLANK name
 *   cell, or 3+ cells (an extra column this parser has no confident meaning for — an ownership percentage,
 *   an EIN), is `unparseable` — decision 6's "when in doubt, abstain and count it", applied literally.
 *
 *   **List/plain-text strategies abstain on the JURISDICTION only, never on the name — except where the
 *   whole line is itself unparseable.** A candidate line that doesn't match a recognized name/jurisdiction
 *   split (a 2+-space column gap, a trailing `(Jurisdiction)` parenthetical, or EXACTLY one comma — 2+ commas
 *   is genuinely ambiguous, since a legal name can itself contain one, e.g. `"Acme Fiber, LLC"`) still
 *   becomes `{name: <the whole line>}` rather than an invented jurisdiction — recording an unsplit name is
 *   not a guess, since nothing about the name itself was uncertain. A line with a 3+-column 2+-space-gap
 *   split is `unparseable` instead (the same "extra column, no confident meaning" abstention the table
 *   strategy applies), and the same header/decoration-row check the table strategy uses is applied to the
 *   split name/jurisdiction here too — the plain-text path gets no free pass on EDGAR's boilerplate titles
 *   just because it has no `<th>` markup to lean on. Only a line that reduces to nothing (after decoding
 *   entities and stripping any stray tags) is `unparseable` on the same basis as a blank line elsewhere.
 *
 *   Tag-stripping (shared by all three strategies, `stripTags`) only inserts a separating space where the
 *   source had no adjacent whitespace already — otherwise it strips to nothing. This matters beyond cosmetic
 *   spacing: naively replacing every tag with a space turns `</p><p>` (two adjacent tags, no interior
 *   whitespace, common in minified filings) into a false 2+-space "column gap" in the plain-text strategy,
 *   and turns `<b>Acme</b> Fiber LLC` into a false gap after `</b>` in the list strategy — both would
 *   otherwise fabricate a name/jurisdiction split the source never intended. The plain-text strategy
 *   additionally rewrites known BLOCK-level tag boundaries (`</p>`, `<br>`, `</tr>`, …) to real line breaks
 *   before stripping the rest — a minified single-line document with no real `\n` at all still gets one
 *   logical line per paragraph/row, rather than every paragraph concatenated onto one fixed-width line.
 *
 *   **Fetch.** {@linkcode fetchExhibit21} is a thin "fetch + parse" pairing — it takes anything satisfying
 *   {@link SECDocumentClient} (one method, `getDocument`, from `sec-client.ts`) rather than the concrete
 *   `SECClient` class, so a test never needs a full axios harness. Discovering WHICH URL a given filing's
 *   Exhibit 21 lives at (the filing index, or EDGAR full-text search) is out of scope here — this module
 *   parses a document once its URL is already known.
 */

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
}

const ROW_PATTERN = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
const CELL_START_PATTERN = /<t([dh])[^>]*>/gi
const TABLE_TAG_PATTERN = /<table[^>]*>|<\/table>/gi

/**
 * Finds the OUTERMOST `<table>...</table>` block in `html` (depth-tracked across nested `<table>`s), or `null` when
 * there is no `<table` at all. Scanning "up to the FIRST `</table>`" (the previous approach) truncates at a nested
 * layout/formatting table's close and never sees the real subsidiary rows that follow it in the outer table — see the
 * module docstring's table-strategy paragraph. An outer `<table>` missing its final `</table>` (truncated/malformed
 * markup) still yields everything after the opening tag, rather than `null`.
 */
function extractOutermostTableHTML(html: string): string | null {
	const firstOpen = /<table[^>]*>/i.exec(html)

	if (!firstOpen) return null

	let depth = 0
	let contentStart = -1

	for (const match of html.matchAll(TABLE_TAG_PATTERN)) {
		if (match.index < firstOpen.index) continue

		if (match[0]!.toLowerCase().startsWith("<table")) {
			if (depth === 0) {
				contentStart = match.index + match[0].length
			}

			depth++
		} else {
			depth--

			if (depth === 0) return html.slice(contentStart, match.index)
		}
	}

	return contentStart === -1 ? null : html.slice(contentStart)
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

		return { tag: start.tag, text: cleanCellText(rowHTML.slice(start.contentStart, end)) }
	})
}

/**
 * Extracts every `<tr>` row's cells from the outermost `<table>...</table>` block in `html`, or `null` when there is no
 * table at all (the caller falls through to the list/plain-text strategies). A row is `[]` when it has no `<td>`/
 * `<th>` cells at all (formatting cruft — an empty `<tr></tr>`), never `null`.
 */
function extractTableRows(html: string): TableCell[][] | null {
	const tableHTML = extractOutermostTableHTML(html)

	if (tableHTML === null) return null

	const rows: TableCell[][] = []

	for (const rowMatch of tableHTML.matchAll(ROW_PATTERN)) {
		rows.push(extractRowCells(rowMatch[1]!))
	}

	return rows
}

const DECORATIVE_ONLY_PATTERN = /^[^a-z0-9]*$/i

const KNOWN_HEADER_LABELS = new Set<string>([
	"name of subsidiary",
	"name of subsidiaries",
	"subsidiary",
	"subsidiaries",
	"subsidiaries of the registrant",
	"list of subsidiaries",
	"name",
	"jurisdiction of incorporation",
	"jurisdiction of incorporation or organization",
	"jurisdiction of organization",
	"state of incorporation",
	"state or jurisdiction of incorporation",
	"state or other jurisdiction of incorporation",
	"jurisdiction",
	"state",
	"% owned",
	"percentage owned",
	"percent owned",
	"ownership",
	"exhibit 21",
	"exhibit 21.1",
	"registrant",
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
 * Turns extracted table rows into {@linkcode ParsedExhibit21} — see the module docstring's "table strategy" section for
 * the exact abstention rules.
 */
function subsidiariesFromTableRows(rows: readonly TableCell[][]): ParsedExhibit21 {
	const subsidiaries: ParsedSubsidiary[] = []
	let unparseable = 0

	for (const row of rows) {
		// An empty <tr></tr> — formatting cruft, not a data row either way.
		if (!row.length) continue

		// A row made ENTIRELY of <th> cells — a header/label row, recognized and skipped (structural certainty).
		if (row.every((cell) => cell.tag === "th")) continue

		const values = row.map((cell) => cell.text)

		// A header/decoration row using <td> instead of <th> — recognized the same way, but COUNTED, since this
		// is a content judgment rather than markup certainty (decision 6: count a judgment call, don't discard it
		// for free).
		if (isHeaderOrDecorationRow(values)) {
			unparseable++

			continue
		}

		if (values.length > 2) {
			// An extra column this parser has no confident meaning for (an ownership percentage, an EIN) —
			// decision 6: abstain rather than guess which two of N columns are name/jurisdiction.
			unparseable++

			continue
		}

		const [name, jurisdiction] = values as [string, string?]

		if (!name) {
			unparseable++

			continue
		}

		subsidiaries.push(jurisdiction ? { name, jurisdiction } : { name })
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
 * Splits one candidate line (a plain-text row, or one `<li>`'s own text) into a name and an optional jurisdiction — see
 * the module docstring's "list/plain-text strategies" section for why this only ever abstains on the JURISDICTION,
 * never the name. Tried in order:
 *
 * 1. A 2+-space (or tab) column gap — the fixed-width plain-text convention.
 * 2. A trailing `(Jurisdiction)` parenthetical — the common nested-list-item convention.
 * 3. EXACTLY one comma — `"Acme Fiber LLC, Delaware"`. Zero or 2+ commas is NOT split this way (a legal name can itself
 *    contain a comma, e.g. `"Acme Fiber, LLC"`, so 2+ commas is genuinely ambiguous about where the name ends) —
 *    decision 6 abstains from the split, not from recording the line.
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
		.filter(Boolean)

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

		if (name && jurisdiction) return { name, jurisdiction }
	}

	return { name: trimmedWhole }
}

/**
 * Shared by the list and plain-text strategies: split every candidate line, count a blank result as `unparseable` (the
 * only abstention these two strategies ever make on the NAME — see the module docstring), apply the same
 * header/decoration-row check the table strategy uses (a plain-text or `<li>` document has no `<th>` markup to lean on,
 * so its boilerplate title/column-header lines need the same content-based recognition), and keep the rest.
 */
function subsidiariesFromLines(lines: readonly string[]): ParsedExhibit21 {
	const subsidiaries: ParsedSubsidiary[] = []
	let unparseable = 0

	for (const line of lines) {
		const candidate = splitCandidateLine(line)

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
 * Parses an Exhibit 21 document into its subsidiary list. Decision 6 binds: a row/line that cannot be confidently
 * extracted is counted (`unparseable`) and dropped, never guessed at — this function NEVER throws on malformed input
 * (gate 3); the worst case for a document this parser cannot make sense of at all is `{subsidiaries: [], unparseable:
 * N}`.
 *
 * Tries three shapes, in order, and commits to the FIRST one it detects (a real Exhibit 21 uses one consistent format
 * throughout, so there's no ambiguity in picking the first match rather than trying all three and merging):
 *
 * 1. An HTML `<table>` — the common modern shape.
 * 2. A `<li>`-based list (nested subsidiary trees included, flattened) — see {@linkcode extractListItemOwnText}'s
 *    docstring for how nesting is handled without a real HTML parser.
 * 3. Plain fixed-width text (no recognized markup at all) — the older SGML-era shape.
 */
export function parseExhibit21(html: string): ParsedExhibit21 {
	const tableRows = extractTableRows(html)

	if (tableRows !== null) {
		return subsidiariesFromTableRows(tableRows)
	}

	const listLines = extractListItemOwnText(html)

	if (listLines.length) {
		return subsidiariesFromLines(listLines)
	}

	return subsidiariesFromLines(extractPlainTextLines(html))
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
