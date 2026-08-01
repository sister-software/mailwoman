/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Exhibit 21 ("Subsidiaries of the Registrant") fetch + parse (3b Task 7, decision 6, gate 3).
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
 *   **No HTML-parser dependency.** This workspace has none (`@mailwoman/filer`'s only runtime deps are
 *   `@mailwoman/*` workspaces + kysely + type-fest — see `form499.ts`/`provider-list.ts` for the identical
 *   hand-rolled-parser precedent), and Exhibit 21's known shapes don't need one. Table/list extraction below
 *   is a small, deliberately narrow regex-based scan — not a general HTML parser, and not trying to be one.
 *
 *   **Table strategy — the header-row rule is structural, not keyword-sniffing.** A row made ENTIRELY of
 *   `<th>` cells is recognized as a header/label row and skipped (neither counted as a subsidiary nor as
 *   `unparseable`) — this is unambiguous given well-formed markup, unlike guessing from cell text containing
 *   "subsidiary" or "jurisdiction" (which would misfire on a company literally named that). A data row with
 *   exactly 1 or 2 non-empty cells is confident (`{name}` or `{name, jurisdiction}`); a row with 0 cells is
 *   silently ignored as formatting cruft (an empty `<tr></tr>`); a row with a BLANK name cell, or 3+ cells
 *   (an extra column this parser has no confident meaning for — an ownership percentage, an EIN), is
 *   `unparseable` — decision 6's "when in doubt, abstain and count it", applied literally.
 *
 *   **List/plain-text strategies abstain on the JURISDICTION only, never on the name.** A candidate line
 *   that doesn't match a recognized name/jurisdiction split (a 2+-space column gap, a trailing
 *   `(Jurisdiction)` parenthetical, or EXACTLY one comma — 2+ commas is genuinely ambiguous, since a legal
 *   name can itself contain one, e.g. `"Acme Fiber, LLC"`) still becomes `{name: <the whole line>}` rather
 *   than an invented jurisdiction — recording an unsplit name is not a guess, since nothing about the name
 *   itself was uncertain. Only a line that reduces to nothing (after decoding entities and stripping any
 *   stray tags) is `unparseable`.
 *
 *   **Fetch.** {@linkcode fetchExhibit21} is the thin "fetch + parse" pairing the task brief names — it
 *   takes anything satisfying {@link SECDocumentClient} (the one method, `getDocument`, `sec-client.ts`'s
 *   Task 0 addition) rather than the concrete `SECClient` class, so a test never needs a full axios harness.
 *   Discovering WHICH URL a given filing's Exhibit 21 lives at (the filing index, or EDGAR full-text search)
 *   is out of scope here — this module parses a document once its URL is already known.
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

function stripTags(html: string): string {
	return html.replaceAll(TAG_PATTERN, " ")
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
function decodeEntities(text: string): string {
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

function normalizeWhitespace(text: string): string {
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
const CELL_PATTERN = /<t([dh])[^>]*>([\s\S]*?)<\/t[dh]>/gi

/**
 * Extracts every `<tr>` row's cells from the FIRST `<table>...</table>` block in `html`, or `null` when there is no
 * table at all (the caller falls through to the list/plain-text strategies). A row is `[]` when it has no `<td>`/
 * `<th>` cells at all (formatting cruft — an empty `<tr></tr>`), never `null`.
 */
function extractTableRows(html: string): TableCell[][] | null {
	const tableMatch = /<table[^>]*>([\s\S]*?)<\/table>/i.exec(html)

	if (!tableMatch) return null

	const tableHTML = tableMatch[1]!
	const rows: TableCell[][] = []

	for (const rowMatch of tableHTML.matchAll(ROW_PATTERN)) {
		const rowHTML = rowMatch[1]!
		const cells: TableCell[] = []

		for (const cellMatch of rowHTML.matchAll(CELL_PATTERN)) {
			cells.push({ tag: cellMatch[1]!.toLowerCase() === "h" ? "th" : "td", text: cleanCellText(cellMatch[2]!) })
		}

		rows.push(cells)
	}

	return rows
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

		// A row made ENTIRELY of <th> cells — a header/label row, recognized and skipped.
		if (row.every((cell) => cell.tag === "th")) continue

		const values = row.map((cell) => cell.text)

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

/**
 * Strips any stray markup, decodes entities, and splits into non-blank lines — the plain-text strategy's input prep.
 * Whitespace is deliberately NOT collapsed here (unlike {@linkcode cleanCellText}): a fixed-width plain-text Exhibit 21
 * uses a run of 2+ spaces as its column separator, and {@linkcode splitCandidateLine} needs that run intact to find
 * it.
 */
function extractPlainTextLines(html: string): string[] {
	const text = decodeEntities(stripTags(html))

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
 * never a fabricated one.
 */
function splitCandidateLine(line: string): { name: string; jurisdiction?: string } {
	const spaced = line
		.split(/[ \t]{2,}/)
		.map((part) => normalizeWhitespace(part))
		.filter(Boolean)

	if (spaced.length === 2) {
		return { name: spaced[0]!, jurisdiction: spaced[1] }
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
 * only abstention these two strategies ever make on the NAME — see the module docstring), and keep the rest.
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
 * The slice of `SECClient` (`sec-client.ts`, 3b Task 0) this module needs — {@linkcode fetchExhibit21} takes this rather
 * than the concrete class so a test can substitute a trivial stub instead of building a full axios harness. A real
 * `createSECClient()` instance already satisfies this structurally.
 */
export interface SECDocumentClient {
	getDocument(input: string | URL): Promise<string>
}

/**
 * Fetches one Exhibit 21 document (through the shared SEC client's `getDocument`, Task 0's raw-text path) and parses
 * it. Discovering WHICH URL a filing's Exhibit 21 lives at is out of scope here — the caller supplies it (from the
 * filing's own archive index, however that's found).
 */
export async function fetchExhibit21(client: SECDocumentClient, url: string | URL): Promise<ParsedExhibit21> {
	const html = await client.getDocument(url)

	return parseExhibit21(html)
}
