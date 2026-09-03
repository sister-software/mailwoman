/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reading an HTML `<table>` as a grid of cells, for documents that state tabular data as markup and
 *   nothing more — no schema, no column meanings, no domain vocabulary. What a caller gets back is the
 *   grid the document states; deciding what a column MEANS is the caller's, in the caller's package.
 *
 *   The whole document is parsed ONCE, with `htmlparser2`, and every question below is answered against
 *   that tree. The regex readings this module replaced could not answer any of the three questions that
 *   actually decide a grid — is this table nested inside a cell, does this row belong to this table, does
 *   this cell belong to this row — because each is a question about ANCESTRY, and a depth counter over a
 *   token stream loses ancestry the moment the markup is malformed. EDGAR markup is malformed constantly.
 */

import render from "dom-serializer"
import { isTag, type AnyNode, type Element } from "domhandler"
import { findAll } from "domutils"
import { parseDocument } from "htmlparser2"
import { TextSpliterator } from "spliterator"

import { BLOCK_ELEMENTS, htmlToLayoutText } from "#html/text"
import { normalizeWhitespace } from "#strings/format"

/**
 * One `<td>`/`<th>` as read from the document.
 */
export interface TableCell {
	tag: "td" | "th"
	text: string
	/**
	 * The cell's text SPLIT WHERE THE SOURCE BROKE IT — one entry per block-level boundary (`</p>`, `</div>`, `<br>`,
	 * `</li>`), blanks dropped. {@linkcode TableCell.text} is these joined by a space, and a caller that must tell one
	 * long value from several stacked ones reads this instead of re-parsing the cell's markup.
	 */
	blocks: string[]
}

/**
 * The empty cell used to pad rows to a uniform width.
 */
export const BLANK_CELL: TableCell = { tag: "td", text: "", blocks: [] }

/**
 * The nearest ancestor of `node` with one of `names`, or `null`. This is the whole basis of the grid: a table is
 * top-level when its nearest `table` ancestor is `null`, a row belongs to the table that is its nearest `table`
 * ancestor, and a cell belongs to the row that is its nearest `tr` ancestor. One rule, applied three times, and a
 * nested layout table stays with the cell it sits in rather than becoming a table, a row, or a cell of its own.
 */
function nearestAncestor(node: AnyNode, names: ReadonlySet<string>): Element | null {
	for (let current = node.parentNode; current; current = current.parentNode) {
		if (isTag(current) && names.has(current.name)) return current
	}

	return null
}

const TABLE_ANCESTOR = new Set(["table"])
const ROW_ANCESTOR = new Set(["tr"])

function readCell(cell: Element): TableCell {
	const content = htmlToLayoutText(render(cell.children), BLOCK_ELEMENTS)

	// Each block is collapsed and a block with no text is dropped: a `<td>` padded with `&#160;` states one
	// block, not two, and a caller comparing a header label against a fixed set needs single spaces.
	const blocks = TextSpliterator.from(content, { skipEmpty: true })
		.toArray()
		.map(normalizeWhitespace)
		.filter((block) => block !== "")

	return { tag: cell.name === "th" ? "th" : "td", text: blocks.join(" "), blocks }
}

/**
 * Reads every TOP-LEVEL table in `html` as rows of cells, in document order, or `null` when the document states no
 * table at all (the caller decides what to do with a document that is not tabular). A row with no `<td>`/`<th>` at all
 * — formatting cruft, an empty `<tr></tr>` — reads as `[]`, never `null`.
 *
 * Every top-level table is returned, not just the first: a source that splits one logical table across sibling
 * page-break tables is common, and only the first such table carries a header row.
 */
export function extractTableRows(html: string): TableCell[][][] | null {
	const document = parseDocument(html, { decodeEntities: true })

	const tables = findAll((element) => element.name === "table", document).filter(
		(table) => nearestAncestor(table, TABLE_ANCESTOR) === null
	)

	if (!tables.length) return null

	// Assigned by ONE pass each rather than a nested scan: a filing that states 33 sibling tables over a
	// thousand rows makes "for each table, filter every row" quadratic, and the ancestor walk is the inner term.
	const cellsByRow = new Map<Element, TableCell[]>()
	const rowsByTable = new Map<Element, TableCell[][]>(tables.map((table) => [table, []]))

	for (const cell of findAll((element) => element.name === "td" || element.name === "th", document)) {
		const row = nearestAncestor(cell, ROW_ANCESTOR)

		if (!row) continue

		const siblings = cellsByRow.get(row)

		if (siblings) {
			siblings.push(readCell(cell))
		} else {
			cellsByRow.set(row, [readCell(cell)])
		}
	}

	for (const row of findAll((element) => element.name === "tr", document)) {
		// A row inside a NESTED table has that table as its nearest ancestor, which is not a key here — so the
		// row stays with the cell it decorates instead of leaking into the top-level grid.
		const table = nearestAncestor(row, TABLE_ANCESTOR)

		if (table) {
			rowsByTable.get(table)?.push(cellsByRow.get(row) ?? [])
		}
	}

	return tables.map((table) => rowsByTable.get(table)!)
}

/**
 * The cell count of the widest row.
 */
export function widestRow(rows: readonly TableCell[][]): number {
	let width = 0

	for (const row of rows) {
		width = Math.max(width, row.length)
	}

	return width
}

/**
 * Right-pads every row to the table's widest row, then drops each column index that is blank in EVERY row. Per table,
 * and column-wise — never per row. A row-by-row "filter out the blanks" loses the fact that a row's LEADING cell was
 * blank, which is often the difference between a top-level row and an indented child row, and no single row carries
 * enough evidence to tell those apart.
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
