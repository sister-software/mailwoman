/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Read HTML tables as grids of cells without assigning meaning to their columns. Parsing the
 *   document tree preserves table, row, and cell ancestry, including in malformed markup.
 */

import render from "dom-serializer"
import { isTag, type AnyNode, type Element } from "domhandler"
import { findAll } from "domutils"
import { parseDocument } from "htmlparser2"
import { TextSpliterator } from "spliterator"

import { BLOCK_ELEMENTS, htmlToLayoutText } from "#html/text"
import { normalizeWhitespace } from "#strings/format"

/**
 * One parsed table cell.
 */
export interface TableCell {
	tag: "td" | "th"
	text: string
	/**
	 * Non-empty text blocks, split at block-level boundaries.
	 * `text` joins these with spaces.
	 */
	blocks: string[]
}

/**
 * Empty cell used to pad short rows.
 */
export const BLANK_CELL: TableCell = { tag: "td", text: "", blocks: [] }

/**
 * Find the nearest matching ancestor, or return `null`.
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

	// Normalize each block and discard blocks without text.
	const blocks = TextSpliterator.from(content, { skipEmpty: true })
		.toArray()
		.map(normalizeWhitespace)
		.filter((block) => block !== "")

	return { tag: cell.name === "th" ? "th" : "td", text: blocks.join(" "), blocks }
}

/**
 * Return all top-level tables in document order, or `null` when none exist.
 * Empty rows are `[]`.
 */
export function extractTableRows(html: string): TableCell[][][] | null {
	const document = parseDocument(html, { decodeEntities: true })

	const tables = findAll((element) => element.name === "table", document).filter(
		(table) => nearestAncestor(table, TABLE_ANCESTOR) === null
	)

	if (!tables.length) return null

	// Index cells by row in one pass to avoid rescanning all rows for each table.
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
		// Nested rows remain grouped with their nearest table.
		const table = nearestAncestor(row, TABLE_ANCESTOR)

		if (table) {
			rowsByTable.get(table)?.push(cellsByRow.get(row) ?? [])
		}
	}

	return tables.map((table) => rowsByTable.get(table)!)
}

/**
 * Return the number of cells in the widest row.
 */
export function widestRow(rows: readonly TableCell[][]): number {
	let width = 0

	for (const row of rows) {
		width = Math.max(width, row.length)
	}

	return width
}

/**
 * Pad rows to equal width, then remove columns that are empty in every row.
 *
 * Column positions are preserved so blank leading cells retain their structural meaning.
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
