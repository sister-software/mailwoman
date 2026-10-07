/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Independently derives Exhibit 21 subsidiary expectations from the vendored filings.
 *
 *   This implementation deliberately does not import the production Exhibit 21 parser or its vocabulary.
 *   It parses a DOM directly and records which rows it declines to interpret. A reviewer still compares its
 *   output with the source documents before changing `expected.json`.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { isPresent } from "@mailwoman/core/objects"
import { canonicalizeOrganizationName } from "@mailwoman/record/organization"
import render from "dom-serializer"
import { isTag, type AnyNode, type Element } from "domhandler"
import { findAll, removeElement, textContent } from "domutils"
import { parseDocument } from "htmlparser2"
import type { PathBuilderLike } from "path-ts"
import { TextSpliterator } from "spliterator"

const BULLET = /^[•●▪◦·*–—]+\s*/u
const FOOTNOTE = /^(?:[([]?\d{1,3}[)\]]?|\*{1,3})$/u
const PAREN_TAIL = /^(?<name>.+?)\s*\((?<jurisdiction>[^()]{2,60})\)\s*$/u

const JURISDICTION_LABEL =
	/^(?:jurisdiction|domicile|state|country|state\/country of organization|jurisdiction of (?:incorporation|organization|formation)(?: or (?:organization|formation))?|state (?:of|or) .*(?:incorporation|organization|formation).*|state or country of incorporation|state\/country of formation|place of incorporation|where organized|organized under the laws of)$/iu

const NAME_LABEL =
	/^(?:name|legal name|entity name|full legal name|name of entity|subsidiary|subsidiaries|subsidiary name|name of subsidiar(?:y|ies)|legal entity|subsidiary companies|registrant)$/iu

const OTHER_LABEL =
	/^(?:%\s*of ownership|percent(?:age)?(?: owned| of ownership)?|ownership(?: percentage)?|name doing business as|conducts business under|d\/?b\/?a|other name\(s\) under which entity does business|ein|employer identification.*)$/iu

const TITLE_LABEL =
	/^(?:exhibit\s*21(?:\.\d+)?(?:[\s\-–—:]+list of subsidiaries)?|list of subsidiaries.*|subsidiaries of .*|.+ and subsidiaries|domestic subsidiaries|foreign subsidiaries|as of .*)$/iu

const WORD_CAP = 12
// A name-over-name table needs enough rows for repetition to distinguish names from jurisdictions.
const MINIMUM_NAME_PAIR_ROWS = 4
// Three legal designations in one flattened value indicate several entity names rather than one entity.
const MULTI_ENTITY_DESIGNATION_COUNT = 3
const BLOCK_ELEMENTS = ["p", "div", "li", "tr", "br", "h1", "h2", "h3", "h4", "h5", "h6", "td", "th"]

type StatName =
	| "blank"
	| "header"
	| "footnote"
	| "heading"
	| "wide"
	| "leadblank"
	| "blankname"
	| "jurisdiction-is-a-name"
	| "name-name-table"
	| "too-long"
	| "merged-cell"

export interface ReferenceSubsidiary {
	name: string
	jurisdiction: string | null
}

export interface ReferenceAnalysis {
	file: string
	strategy: "table" | "lines"
	topLevelTables: number
	count: number
	abstentions: Partial<Record<StatName, number>>
	subsidiaries: ReferenceSubsidiary[]
}

interface ReferenceCell {
	text: string
	blocks: string[]
}

type Stats = Record<StatName, number>

type ColumnMapping = readonly [name: number, jurisdiction: number]

function emptyStats(): Stats {
	return {
		blank: 0,
		header: 0,
		footnote: 0,
		heading: 0,
		wide: 0,
		leadblank: 0,
		blankname: 0,
		"jurisdiction-is-a-name": 0,
		"name-name-table": 0,
		"too-long": 0,
		"merged-cell": 0,
	}
}

function normalize(value: string): string {
	return value.replaceAll("\u00A0", " ").replaceAll("\u200B", "").replaceAll(/\s+/gu, " ").trim()
}

function visible(node: AnyNode): string {
	return normalize(textContent(node))
}

function stripSGML(raw: string): string {
	const start = /<TEXT>/iu.exec(raw)
	const body = start ? raw.slice(start.index + start[0].length) : raw
	const end = /<\/TEXT>/iu.exec(body)

	return end ? body.slice(0, end.index) : body
}

function nearestTable(node: AnyNode): Element | null {
	for (let parent = node.parentNode; parent; parent = parent.parentNode) {
		if (isTag(parent) && parent.name === "table") return parent
	}

	return null
}

function readCell(cell: Element): ReferenceCell {
	const blocks = cell.children.flatMap((child) =>
		isTag(child) && BLOCK_ELEMENTS.includes(child.name) && visible(child) ? [visible(child)] : []
	)

	return { text: visible(cell), blocks }
}

function rowsOf(table: Element): ReferenceCell[][] {
	const rows: ReferenceCell[][] = []

	for (const row of findAll((element) => element.name === "tr", table.children)) {
		if (nearestTable(row) !== table) continue

		const cells = row.children.filter(
			(child): child is Element => isTag(child) && (child.name === "td" || child.name === "th")
		)

		rows.push(cells.map(readCell))
	}

	return rows
}

function dropBlankColumns(rows: readonly ReferenceCell[][]): ReferenceCell[][] {
	let width = 0

	for (const row of rows) {
		width = Math.max(width, row.length)
	}

	const columns = Array.from({ length: width }, (_, index) => index).filter((index) =>
		rows.some((row) => (row[index]?.text ?? "") !== "")
	)

	return rows.map((row) => columns.map((index) => row[index] ?? { text: "", blocks: [] }))
}

function isHeaderish(value: string): boolean {
	return JURISDICTION_LABEL.test(value) || NAME_LABEL.test(value) || OTHER_LABEL.test(value) || TITLE_LABEL.test(value)
}

function designationCount(value: string): number {
	return canonicalizeOrganizationName(value)?.designations.length ?? 0
}

function containsMultipleEntityNames(blocks: readonly string[]): boolean {
	for (let split = 1; split < blocks.length; split++) {
		const before = blocks.slice(0, split).join(" ")
		const after = blocks.slice(split).join(" ")

		if (designationCount(before) > 0 && designationCount(after) > 0) return true
	}

	return false
}

function headerMapping(rows: readonly ReferenceCell[][]): ColumnMapping | null {
	for (const row of rows) {
		const values = row.map((cell) => cell.text).filter(isPresent)

		if (!values.length || !values.every(isHeaderish)) continue

		const jurisdictionColumns = row.flatMap((cell, index) =>
			cell.text && JURISDICTION_LABEL.test(cell.text) ? [index] : []
		)

		if (jurisdictionColumns.length !== 1) continue

		const jurisdiction = jurisdictionColumns[0]!

		for (const [index, cell] of row.entries()) {
			if (index !== jurisdiction && !(cell.text && OTHER_LABEL.test(cell.text))) {
				return [index, jurisdiction]
			}
		}
	}

	return null
}

function classifyTable(
	inputRows: readonly ReferenceCell[][],
	stats: Stats,
	carried: ColumnMapping | null
): { subsidiaries: ReferenceSubsidiary[]; mapping: ColumnMapping | null } {
	const subsidiaries: ReferenceSubsidiary[] = []
	const rows = dropBlankColumns(inputRows)
	const mapping = headerMapping(rows) ?? carried
	const pairs = rows.map((row) => row.map((cell) => cell.text).filter(isPresent))
	const two = pairs.filter((pair) => pair.length === 2 && !FOOTNOTE.test(pair[0]!) && !pair.every(isHeaderish))

	if (!mapping && two.length >= MINIMUM_NAME_PAIR_ROWS) {
		const seconds = two.map((pair) => pair[1]!)
		const designated = seconds.filter((value) => designationCount(value) > 0).length
		const distinct = new Set(seconds).size

		if (designated * 2 > two.length && distinct * 10 > two.length * 7) {
			stats["name-name-table"] += two.length

			return { subsidiaries, mapping }
		}
	}

	const singleRows = pairs.filter((pair) => pair.length === 1).length
	const allSingle = pairs.length > 0 && pairs.every((pair) => pair.length <= 1) && singleRows >= 2

	for (const row of rows) {
		const values = row.map((cell) => cell.text).filter(isPresent)

		if (!values.length) {
			stats.blank++

			continue
		}

		if (values.every(isHeaderish)) {
			stats.header++

			continue
		}

		if (FOOTNOTE.test(values[0]!)) {
			stats.footnote++

			continue
		}

		if (values.length === 1 && !allSingle) {
			stats.heading++

			continue
		}

		if (designationCount(values[0]!) >= MULTI_ENTITY_DESIGNATION_COUNT) {
			stats["merged-cell"]++

			continue
		}

		if (mapping) {
			const [nameIndex, jurisdictionIndex] = mapping
			let nameCell = row[nameIndex]
			const jurisdictionCell = row[jurisdictionIndex]
			const jurisdiction = jurisdictionCell?.text ?? ""

			if (!nameCell?.text && nameIndex < jurisdictionIndex) {
				nameCell = row.slice(nameIndex + 1, jurisdictionIndex).find((cell) => cell.text !== "")
			}

			if (nameCell?.text) {
				if (containsMultipleEntityNames(nameCell.blocks)) {
					stats["merged-cell"]++

					continue
				}

				subsidiaries.push({ name: nameCell.text, jurisdiction: jurisdiction || null })

				continue
			}
		}

		if (values.length > 2) {
			stats.wide++

			continue
		}

		if (!row[0]?.text) {
			stats.leadblank++

			continue
		}

		if (values.length === 1) {
			subsidiaries.push({ name: values[0]!, jurisdiction: null })

			continue
		}

		subsidiaries.push({ name: values[0]!, jurisdiction: values[1]! })
	}

	return { subsidiaries, mapping }
}

function fromTables(document: AnyNode, stats: Stats): { subsidiaries: ReferenceSubsidiary[]; count: number } {
	const tables = findAll((element) => element.name === "table", [document]).filter(
		(table) => nearestTable(table) === null
	)

	const subsidiaries: ReferenceSubsidiary[] = []
	let mapping: ColumnMapping | null = null

	for (const table of tables) {
		const result = classifyTable(rowsOf(table), stats, mapping)
		mapping = result.mapping
		subsidiaries.push(...result.subsidiaries)
	}

	return { subsidiaries, count: tables.length }
}

function textLines(document: AnyNode): string[] {
	let html = render(document)

	for (const tag of BLOCK_ELEMENTS) {
		html = html.replaceAll(new RegExp(`</?${tag}[^>]*>`, "giu"), "\n")
	}

	const text = textContent(parseDocument(`<div>${html}</div>`, { decodeEntities: true }))

	return TextSpliterator.from(text.replaceAll("\u00A0", " ").replaceAll("\u200B", ""))
		.map((line) => line.replaceAll(/[ \t]+/gu, " ").trim())
		.filter(isPresent)
		.toArray()
}

function fromLines(lines: readonly string[], stats: Stats): ReferenceSubsidiary[] {
	const subsidiaries: ReferenceSubsidiary[] = []

	for (const line of lines) {
		const candidate = line.replace(BULLET, "").trim()

		if (!candidate) continue

		if (isHeaderish(candidate)) {
			stats.header++

			continue
		}

		if (FOOTNOTE.test(candidate)) {
			stats.footnote++

			continue
		}

		if (candidate.split(/\s+/u).length > WORD_CAP) {
			stats["too-long"]++

			continue
		}

		const parenthetical = PAREN_TAIL.exec(candidate)
		const name = parenthetical?.groups?.["name"]?.trim()
		const jurisdiction = parenthetical?.groups?.["jurisdiction"]?.trim()

		if (name && jurisdiction && designationCount(jurisdiction) === 0) {
			subsidiaries.push({ name, jurisdiction })

			continue
		}

		const parts = candidate.split(/\s{2,}/u).map((part) => part.trim())

		if (parts.length === 2) {
			subsidiaries.push({ name: parts[0]!, jurisdiction: parts[1]! })

			continue
		}

		if (parts.length > 2) {
			stats.wide++

			continue
		}

		subsidiaries.push({ name: candidate, jurisdiction: null })
	}

	return subsidiaries
}

/**
 * Derives one audit record from a vendored Exhibit 21 document.
 */
export async function analyzeReferenceDocument(path: PathBuilderLike): Promise<ReferenceAnalysis> {
	const raw = await readLocalTextFile(path)
	const document = parseDocument(stripSGML(raw), { decodeEntities: true })

	for (const unwanted of findAll(
		(element) => ["head", "script", "style", "title"].includes(element.name),
		document.children
	)) {
		removeElement(unwanted)
	}

	let stats = emptyStats()
	const tableResult = fromTables(document, stats)
	let subsidiaries = tableResult.subsidiaries
	let strategy: ReferenceAnalysis["strategy"] = "table"

	if (!subsidiaries.length) {
		stats = emptyStats()
		subsidiaries = fromLines(textLines(document), stats)
		strategy = "lines"
	}

	return {
		file: path.toString().split(/[\\/]/u).at(-1)!,
		strategy,
		topLevelTables: tableResult.count,
		count: subsidiaries.length,
		abstentions: Object.fromEntries(Object.entries(stats).filter(([, count]) => count > 0)),
		subsidiaries,
	}
}
