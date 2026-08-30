/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The pipe-delimited NASIS export inside a survey-area archive: which file holds which table, which
 *   column sits at which position, and the authority's own declared domains.
 *
 *   THE FILES CARRY NO HEADER AND THE ARCHIVE SHIPS THE SCHEMA. `mstab.txt` maps a logical table name to
 *   the file base name that holds it (`component` → `comp.txt`, `sacatalog` → `sacatlog.txt` — neither is
 *   guessable), and `mstabcol.txt` gives every column's ordinal position. So the reader looks the positions
 *   up rather than hard-coding them, and {@link readTable} THROWS on a requested column the shipped
 *   dictionary does not declare. A reader that quietly returned `undefined` for a renamed column would turn
 *   "the source changed" into "there is none of it", at exactly the measurement boundary where that lie
 *   costs the most.
 *
 *   QUOTE HANDLING IS NOT OPTIONAL HERE, AND THE MEASUREMENT determines the result. `sacatlog.txt` holds 594 newline
 *   bytes and exactly ONE record: its `fgdcmetadata` column carries a 43,251-character XML document with
 *   embedded newlines. `mstabcol.txt` — the column dictionary itself — holds 913 newlines and 865 records.
 *   A line-splitting reader gets 594 malformed rows from a one-row file, every one of them well-formed
 *   enough to keep going.
 *
 *   THE DECLARED DOMAINS COME OUT OF THE ARCHIVE TOO, which is stronger than transcribing them.
 *   `msdomdet.txt` carries every `Choice` column's members WITH the authority's own prose definition —
 *   capability classes 1 through 8, subclasses `c`/`e`/`s`/`w`, the 28 conditional farmland
 *   classifications, the six component kinds. The layer stores them and validates against them.
 */

import { readLocalBufferSync } from "@mailwoman/core/fs/readers-sync"
import { join } from "@mailwoman/platform/path"
import { CSVSpliterator } from "spliterator"

/**
 * One parsed record: the raw column strings, in the authority's declared order.
 */
export type TabularRow = ReadonlyArray<string>

/**
 * Read one pipe-delimited export file into rows.
 *
 * `enableQuoteHandling` is what makes the embedded newlines above survive; `header: false` is what keeps the first
 * record from being eaten, since these files carry none.
 */
function readPipeDelimited(path: string): TabularRow[] {
	const rows: TabularRow[] = []

	for (const row of CSVSpliterator.from(readLocalBufferSync(path), {
		mode: "array",
		header: false,
		columnDelimiter: "|",
		enableQuoteHandling: true,
	})) {
		// `String` ON A DECLARED STRING IS NOT REDUNDANT HERE. The emitter's array mode is TYPED `string[]` and coerces
		// numeric-looking columns at RUNTIME — measured: `mukey` comes back as the number 412818, not `"412818"` — so a row
		// passed through untouched stops joining against the shapefile's own `MUKEY`. An empty column arrives as `""`
		// rather than as null, which is why nothing here has to decide what a missing value means.
		rows.push(row.map((value) => String(value)))
	}

	return rows
}

/**
 * The archive's own description of itself: table → file, and table → column positions.
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
 * These two are the ONLY positions this module hard-codes, and they cannot be looked up because they are what the
 * lookup is built from. Both files declare themselves in `mstabcol.txt`, so the assertions below check the bootstrap
 * against the archive's own account of it rather than trusting it.
 */
const MSTAB_TABLE_NAME = 0
const MSTAB_FILE_NAME = 4
const MSTABCOL_TABLE_NAME = 0
const MSTABCOL_POSITION = 1
const MSTABCOL_COLUMN_NAME = 2

/**
 * Declared widths of the two bootstrap files, asserted before either is read as a dictionary. A different width means
 * the metadata format changed, and reading positions out of a changed format is how a builder mis-reads every column at
 * once.
 */
const MSTAB_WIDTH = 5
const MSTABCOL_WIDTH = 14

/**
 * Read the archive's table and column dictionaries.
 *
 * @throws {Error} When either bootstrap file is missing or is not the declared width.
 */
export function readTabularDictionary(tabularDirectory: string): TabularDictionary {
	const mstab = readPipeDelimited(join(tabularDirectory, "mstab.txt"))
	const mstabcol = readPipeDelimited(join(tabularDirectory, "mstabcol.txt"))

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
 * The projection is by NAME and a missing name throws, which is the whole point: this is the shape that produced the
 * repository's worst measurement bugs, where a silently dropped column read downstream as an empty world.
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
 * Read a logical SSURGO table, projecting `wanted` columns.
 *
 * @throws {Error} When the archive declares no file for the table, when a requested column is not in the shipped
 *   dictionary, or when a record is narrower than the position a requested column sits at.
 */
export function readTable(
	tabularDirectory: string,
	dictionary: TabularDictionary,
	table: string,
	wanted: ReadonlyArray<string>
): TabularTable {
	const file = dictionary.files.get(table)

	if (!file) {
		throw new Error(`soil tabular: the archive's mstab.txt declares no file for table ${JSON.stringify(table)}`)
	}

	const positions = dictionary.columns.get(table)

	if (!positions) {
		throw new Error(`soil tabular: the archive's mstabcol.txt declares no columns for table ${JSON.stringify(table)}`)
	}

	const projection: Array<[string, number]> = []

	for (const column of wanted) {
		const position = positions.get(column)

		if (position === undefined) {
			throw new Error(
				`soil tabular: table ${table} declares no column ${JSON.stringify(column)} — the shipped dictionary names ${positions.size} columns, and projecting away a column a caller asked for would read downstream as an absence`
			)
		}

		projection.push([column, position])
	}

	const rows: Array<Record<string, string>> = []
	const raw = readPipeDelimited(join(tabularDirectory, `${file}.txt`))

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
 * Column positions in `msdomdet.txt`. Declared in `mstabcol.txt` under table `msdomdet`, so unlike the two bootstrap
 * files above these could be looked up — they are named here because the domain read runs before any dictionary-driven
 * read and the file is five columns wide by its own declaration.
 */
const MSDOMDET_WIDTH = 5

/**
 * Read the authority's declared domains out of the archive.
 *
 * @throws {Error} When the file is not the declared width.
 */
export function readDeclaredDomains(tabularDirectory: string): DomainMember[] {
	const rows = readPipeDelimited(join(tabularDirectory, "msdomdet.txt"))

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
 * `M/D/YYYY H:MM:SS` (and the `MM/DD/YYYY HH:MM:SS` the tabular export writes) to an ISO date.
 *
 * The two channels spell the same instant differently — Soil Data Access answers `9/9/2025 1:57:25 PM` and the shipped
 * `sacatlog.txt` writes `09/09/2025 13:57:25` — and the download URL needs `2025-09-09`. Parsing to a date rather than
 * slicing the string is what makes both channels agree.
 *
 * @throws {Error} When the value is not one of those shapes. A freshness date guessed wrong asks the download host for
 *   a file that does not exist, and the host answers 400 rather than 404, which reads as a bad request rather than a
 *   bad date.
 */
export function saverestToISODate(value: string): string {
	const matched = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/u.exec(value.trim())

	if (!matched) {
		throw new Error(
			`soil tabular: cannot read ${JSON.stringify(value)} as a saverest date — expected M/D/YYYY, which is what both Soil Data Access and the shipped sacatlog.txt write`
		)
	}

	const [, month, day, year] = matched

	return `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`
}
