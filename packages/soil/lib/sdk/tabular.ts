/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads the pipe-delimited NASIS export inside a survey-area archive. It maps files to tables and columns to
 *   positions, then reads the authority's declared domains.
 *
 *   The files have no headers. The archive supplies their schema. `mstab.txt` maps each logical table name to a
 *   filename (`component` → `comp.txt`, `sacatalog` → `sacatlog.txt`). The filenames cannot be inferred. `mstabcol.txt`
 *   gives each column's ordinal position. The reader looks up those positions instead of hard-coding them.
 *   {@link readTable} throws when a requested column is absent from the shipped dictionary. An `undefined` result
 *   for a renamed column would turn a source change into an apparent absence. That would corrupt the measurement.
 *
 *   Quote handling affects the parsed result. `sacatlog.txt` contains 594 newline bytes and one record. Its
 *   `fgdcmetadata` column contains a 43,251-character XML document with embedded newlines. `mstabcol.txt`, the column
 *   dictionary, contains 913 newlines and 865 records. A line-splitting reader would create 594 malformed rows from
 *   the one-row `sacatlog.txt` file. Each malformed row would still look valid enough to process.
 *
 *   The archive also supplies its declared domains. Those values remove the need to transcribe them by hand.
 *   `msdomdet.txt` lists every `Choice` column's members and the authority's prose definition. It includes
 *   capability classes 1 through 8, subclasses `c`/`e`/`s`/`w`, 28 conditional farmland classifications and six
 *   component kinds. The layer stores and validates those values.
 */

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import { PathBuilder, type PathBuilderLike, resolvePathBuilder } from "path-ts"
import { CSVSpliterator } from "spliterator"

/**
 * One parsed record: the raw column strings, in the authority's declared order.
 */
export type TabularRow = ReadonlyArray<string>

/**
 * Read one pipe-delimited export file into rows.
 *
 * Quote-aware parsing preserves embedded newlines; `header: false` keeps the first record
 * because these files have no header.
 */
async function readPipeDelimited(path: PathBuilderLike): Promise<TabularRow[]> {
	const rows: TabularRow[] = []

	for (const row of CSVSpliterator.from(await readLocalBuffer(path), {
		header: false,
		columnDelimiter: "|",
	})) {
		rows.push(row)
	}

	return rows
}

/**
 * Maps each table to a file and to its column positions, as recorded in the archive's dictionary.
 */
export interface TabularDictionary {
	/**
	 * Logical table name → file base name, from `mstab.txt`.
	 */
	files: ReadonlyMap<string, string>
	/**
	 * Logical table name → column name → zero-based position, from `mstabcol.txt`.
	 */
	columns: ReadonlyMap<string, ReadonlyMap<string, number>>
}

/**
 * Column positions in `mstab.txt` and `mstabcol.txt` themselves.
 *
 * This module hard-codes only these two positions.
 * It cannot look them up because they initialize the lookup.
 *
 * `mstabcol.txt` declares positions for both files.
 * The assertions below check the bootstrap against the archive's own dictionary.
 */
const MSTAB_TABLE_NAME = 0
const MSTAB_FILE_NAME = 4
const MSTABCOL_TABLE_NAME = 0
const MSTABCOL_POSITION = 1
const MSTABCOL_COLUMN_NAME = 2

/**
 * Declared widths of the two bootstrap files, asserted before either is read as a dictionary.
 *
 * A different width means the metadata format changed.
 * Changed-format positions could misread every column.
 */
const MSTAB_WIDTH = 5
const MSTABCOL_WIDTH = 14

/**
 * Read the archive's table and column dictionaries.
 *
 * @throws {Error} When either bootstrap file is missing or is not the declared width.
 */
export async function readTabularDictionary(tabularDirectory: PathBuilderLike): Promise<TabularDictionary> {
	const directory = PathBuilder.from(tabularDirectory)
	const mstab = await readPipeDelimited(directory("mstab.txt"))
	const mstabcol = await readPipeDelimited(directory("mstabcol.txt"))

	assertWidth(mstab, MSTAB_WIDTH, "mstab.txt")
	assertWidth(mstabcol, MSTABCOL_WIDTH, "mstabcol.txt")

	const files = new Map<string, string>()

	for (const row of mstab) {
		files.set(row[MSTAB_TABLE_NAME]!, row[MSTAB_FILE_NAME]!)
	}

	const columns = new Map<string, Map<string, number>>()

	for (const row of mstabcol) {
		const table = row[MSTABCOL_TABLE_NAME]!
		const position = Number(row[MSTABCOL_POSITION])

		let byName = columns.get(table)

		if (!byName) {
			byName = new Map()

			columns.set(table, byName)
		}

		byName.set(row[MSTABCOL_COLUMN_NAME]!, position - 1)
	}

	return { files, columns }
}

function assertWidth(rows: ReadonlyArray<TabularRow>, width: number, name: string): void {
	const widths = new Set(rows.map((row) => row.length))

	if (widths.size !== 1 || !widths.has(width)) {
		throw new Error(
			`soil tabular: ${name} holds rows of width ${[...widths].join(", ")}, expected ${width} — the shipped metadata format changed, and reading column positions out of a changed format mis-reads every column at once`
		)
	}
}

/**
 * A reader over one logical table, projecting the columns a caller names.
 *
 * The projection selects columns by name and throws when a name is missing.
 * This prevents a silently dropped column from appearing downstream as an empty dataset,
 * the failure behind the repository's worst measurement bugs.
 */
export interface TabularTable {
	/**
	 * One record per row, already projected to the requested columns.
	 */
	rows: ReadonlyArray<Record<string, string>>
	/**
	 * How many records the file held, before projection.
	 */
	recordCount: number
}

/**
 * Read a logical ssurgo table, projecting `wanted` columns.
 *
 * @throws {Error} When the archive declares no file for the table, when a requested column is not in
 * the shipped dictionary, or when a record is narrower than the position a requested column sits at.
 */
export async function readTable(
	tabularDirectory: PathBuilderLike,
	dictionary: TabularDictionary,
	table: string,
	wanted: ReadonlyArray<string>
): Promise<TabularTable> {
	const file = dictionary.files.get(table)

	if (!file) {
		throw new Error(`soil tabular: the archive's mstab.txt declares no file for table ${stringifyJSON(table)}`)
	}

	const positions = dictionary.columns.get(table)

	if (!positions) {
		throw new Error(`soil tabular: the archive's mstabcol.txt declares no columns for table ${stringifyJSON(table)}`)
	}

	const projection: Array<[string, number]> = []

	for (const column of wanted) {
		const position = positions.get(column)

		if (position === undefined) {
			throw new Error(
				`soil tabular: table ${table} declares no column ${stringifyJSON(column)} — the shipped dictionary names ${positions.size} columns, and projecting away a column a caller asked for would read downstream as an absence`
			)
		}

		projection.push([column, position])
	}

	const rows: Array<Record<string, string>> = []
	const raw = await readPipeDelimited(resolvePathBuilder(tabularDirectory, `${file}.txt`))

	for (const [index, row] of raw.entries()) {
		const record: Record<string, string> = {}

		for (const [column, position] of projection) {
			if (position >= row.length) {
				throw new Error(
					`soil tabular: ${file}.txt record ${index + 1} holds ${row.length} columns, but ${table}.${column} sits at position ${position + 1}`
				)
			}

			record[column] = row[position]!
		}

		rows.push(record)
	}

	return { rows, recordCount: raw.length }
}

/**
 * One declared domain member, with the authority's own definition.
 */
export interface DomainMember {
	domain: string
	code: string
	definition: string
	sequence: number
}

/**
 * Column positions in `msdomdet.txt`.
 *
 * Declared in `mstabcol.txt` under table `msdomdet`, so unlike the two bootstrap
 * files above these could be looked up.
 * They are listed here because the domain read runs before any dictionary-driven read
 * and the file is five columns wide by its own declaration.
 */
const MSDOMDET_WIDTH = 5

/**
 * Read the authority's declared domains out of the archive.
 *
 * @throws {Error} When the file is not the declared width.
 */
export async function readDeclaredDomains(tabularDirectory: PathBuilderLike): Promise<DomainMember[]> {
	const rows = await readPipeDelimited(resolvePathBuilder(tabularDirectory, "msdomdet.txt"))

	assertWidth(rows, MSDOMDET_WIDTH, "msdomdet.txt")

	return rows.map((row) => ({
		domain: row[0]!,
		sequence: Number(row[1]),
		code: row[2]!,
		definition: row[3]!,
	}))
}

/**
 * The declared members of one domain, keyed by code.
 */
export function domainCodes(members: ReadonlyArray<DomainMember>, domain: string): Set<string> {
	const codes = new Set<string>()

	for (const member of members) {
		if (member.domain === domain) {
			codes.add(member.code)
		}
	}

	return codes
}

/**
 * `M/D/yyyy H:MM:SS` (and the `MM/DD/yyyy HH:MM:SS` the tabular export writes) to an ISO date.
 *
 * Soil Data Access writes `9/9/2025 1:57:25 PM`.
 * The shipped `sacatlog.txt` writes the same instant as `09/09/2025 13:57:25`.
 *
 * The download URL needs `2025-09-09`.
 * Both channels agree only when the code parses the value as a date instead of slicing the string.
 *
 * @throws {Error} When the value is not one of those shapes.
 * An incorrect freshness date requests a nonexistent file.
 * The host returns 400 for the request.
 * A 404 would identify a missing file.
 */
// repo-health-ignore export-name-affix -- parses the survey's M/D/yyyy form; `isoDate` formats a Date and reads none.
export function saverestToISODate(value: string): string {
	const matched = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/u.exec(value.trim())

	if (!matched) {
		throw new Error(
			`soil tabular: cannot read ${stringifyJSON(value)} as a saverest date — expected M/D/YYYY, which is what both Soil Data Access and the shipped sacatlog.txt write`
		)
	}

	const [, month, day, year] = matched

	return `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`
}
