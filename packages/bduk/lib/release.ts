/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reader for the CSV files of Building Digital UK's UPRN-level release, "OMR and premises in BDUK plans".
 *
 *   Each row is one UPRN that BDUK assessed in an Open Market Review (OMR), with its postcode, its subsidy
 *   control status, whether it has a gigabit-capable connection now and in suppliers' plans, and the BDUK
 *   contracts that include it. BDUK's premises base is OS AddressBase Premium filtered to postal addresses
 *   that are not demolished. A UPRN the release omits is therefore a premises BDUK did not assess, and the
 *   release gives it no status.
 *
 *   `current_gigabit` is BDUK's view from suppliers' returns to the OMR and its own delivery data. A
 *   supplier that sends no return leaves a gap, so `false` states BDUK's view rather than an observed
 *   absence of a network. The release names no network for commercial coverage, and its Grey/Black status
 *   covers one qualifying network or several.
 *
 *   The reader returns each requested column typed. A requested column that the header lacks throws
 *   {@linkcode BDUKColumnError}. A cell outside its column's closed vocabulary or form throws
 *   {@linkcode BDUKValueError}, whose message gives the value, its line and its UPRN. An empty cell reads as `null`,
 *   so it stays distinct from `false` and from zero.
 *
 *   The OMR month appears only in the published file name, so the reader requires that name.
 */

import { checkRecordCount, headerColumnIndex } from "@mailwoman/core/fs/delimited"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import { basename, PathBuilder, type PathBuilderLike } from "path-ts"
import { CSVSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"

/**
 * The column that keys every row.
 */
export const BDUK_UPRN_COLUMN = "uprn"

/**
 * The subsidy control statuses that the May 2026 release writes, verbatim.
 *
 * The user guide defines a fourth status, `Unassessed`, for a premises that BDUK did not assess.
 * No row of the May 2026 release holds it, and its spelling in a file is unknown,
 * so the reader refuses it until a release shows that spelling.
 */
export const BDUKSubsidyControlStatus = {
	/**
	 * One or more qualifying gigabit networks from different suppliers are available,
	 * or will be deployed within three years.
	 */
	GreyBlack: "Gigabit Grey/Black",
	/**
	 * No gigabit network is present, and none is likely to be developed within three years.
	 */
	White: "Gigabit White",
	/**
	 * Suppliers reported coverage that BDUK has not verified, or planned build
	 * whose delivery has risks or evidence gaps.
	 */
	UnderReview: "Gigabit Under Review",
} as const

export type BDUKSubsidyControlStatus = (typeof BDUKSubsidyControlStatus)[keyof typeof BDUKSubsidyControlStatus]

/**
 * The scope of a premises in a Gigabit Infrastructure Subsidy contract.
 */
export const BDUKContractScope = {
	/**
	 * The premises is in the contract's confirmed scope.
	 */
	Initial: "Initial",
	/**
	 * The contract includes the premises outside its initial scope.
	 *
	 * The guide states that such a premises may join the scope if it is reclassified as White.
	 */
	Deferred: "Deferred",
} as const

export type BDUKContractScope = (typeof BDUKContractScope)[keyof typeof BDUKContractScope]

/**
 * The countries a release covers.
 */
export const BDUKCountry = {
	England: "England",
	Wales: "Wales",
} as const

export type BDUKCountry = (typeof BDUKCountry)[keyof typeof BDUKCountry]

/**
 * Each column besides `uprn`, keyed by its published header label, with the value a cell reads as.
 *
 * Every value is `null` for an empty cell.
 */
export interface BDUKColumnValues {
	/**
	 * The UPRN with `str` prefixed.
	 *
	 * The prefix keeps spreadsheet software from reading the UPRN as a number.
	 */
	struprn: string | null
	/**
	 * Whether the premises is in BDUK's premises base: a premises where a gigabit-capable
	 * connection would provide benefit, such as a dwelling or a business.
	 */
	bduk_recognised_premises: boolean | null
	/**
	 * The premises' country.
	 */
	country: BDUKCountry | null
	/**
	 * The premises' postcode: the outward code, one space and the inward code.
	 */
	postcode: string | null
	/**
	 * The BDUK lot, a geographic area of procurement.
	 */
	lot_id: number | null
	lot_name: string | null
	subsidy_control_status: BDUKSubsidyControlStatus | null
	/**
	 * Whether the premises has a gigabit-capable connection in BDUK's view on the OMR's reference date.
	 */
	current_gigabit: boolean | null
	/**
	 * Whether suppliers' returns to the OMR plan a gigabit-capable connection for the premises.
	 */
	future_gigabit: boolean | null
	/**
	 * The local authority district's ONS code and name.
	 */
	local_authority_district_ons_code: string | null
	local_authority_district_ons: string | null
	/**
	 * The region's ONS code and name.
	 * Welsh rows give `W99999999` and `Wales`.
	 */
	region_ons_code: string | null
	region_ons: string | null
	/**
	 * Whether a Gigabit Infrastructure Subsidy contract includes the premises,
	 * and that contract's scope, final payment date as `YYYY-MM-DD`, name and suppliers.
	 */
	bduk_gis: boolean | null
	bduk_gis_contract_scope: BDUKContractScope | null
	bduk_gis_final_coverage_date: string | null
	bduk_gis_contract_name: string | null
	bduk_gis_supplier: string | null
	/**
	 * Whether an approved vouchers project includes the premises, with the project and its lead supplier.
	 */
	bduk_vouchers: boolean | null
	bduk_vouchers_contract_name: string | null
	bduk_vouchers_supplier: string | null
	/**
	 * Whether an active Superfast programme contract includes the premises,
	 * with the contract and its supplier.
	 */
	bduk_superfast: boolean | null
	bduk_superfast_contract_name: string | null
	bduk_superfast_supplier: string | null
	/**
	 * The hubs columns.
	 *
	 * The guide states that the hubs programme is complete and that the release
	 * keeps them for readers with set schemas.
	 */
	bduk_hubs: boolean | null
	bduk_hubs_contract_name: string | null
	bduk_hubs_supplier: string | null
}

/**
 * A column a caller can request, by its published header label.
 */
export type BDUKColumn = keyof BDUKColumnValues

/**
 * What a column's cells hold, and how a non-empty cell reads.
 */
interface CellForm<T> {
	/**
	 * The form a cell must take, as the refusal states it.
	 */
	readonly expected: string
	/**
	 * The cell's value, or `undefined` when the cell is outside the form.
	 */
	readonly read: (cell: string) => T | undefined
}

/**
 * A form whose cells are one of a fixed set of published values.
 */
function closedVocabulary<const V extends string>(values: Readonly<Record<string, V>>): CellForm<V> {
	const allowed = new Set<string>(Object.values(values))

	return {
		expected: `one of ${Object.values(values)
			.map((value) => stringifyJSON(value))
			.join(", ")}`,
		read: (cell) => (allowed.has(cell) ? (cell as V) : undefined),
	}
}

/**
 * The release writes every flag in lowercase.
 * The user guide's examples write `TRUE`, and no row does.
 */
const FLAG_FORM: CellForm<boolean> = {
	expected: '"true" or "false"',
	read: (cell) => (cell === "true" ? true : cell === "false" ? false : undefined),
}

const TEXT_FORM: CellForm<string> = { expected: "text", read: (cell) => cell }

const WHOLE_NUMBER_FORM: CellForm<number> = {
	expected: "a whole number",
	read: (cell) => (/^\d+$/u.test(cell) ? Number(cell) : undefined),
}

const DATE_FORM: CellForm<string> = {
	expected: "a date written YYYY-MM-DD",
	read: (cell) => (/^\d{4}-\d{2}-\d{2}$/u.test(cell) ? cell : undefined),
}

const COLUMN_FORMS: { readonly [C in BDUKColumn]: CellForm<NonNullable<BDUKColumnValues[C]>> } = {
	struprn: TEXT_FORM,
	bduk_recognised_premises: FLAG_FORM,
	country: closedVocabulary(BDUKCountry),
	postcode: TEXT_FORM,
	lot_id: WHOLE_NUMBER_FORM,
	lot_name: TEXT_FORM,
	subsidy_control_status: closedVocabulary(BDUKSubsidyControlStatus),
	current_gigabit: FLAG_FORM,
	future_gigabit: FLAG_FORM,
	local_authority_district_ons_code: TEXT_FORM,
	local_authority_district_ons: TEXT_FORM,
	region_ons_code: TEXT_FORM,
	region_ons: TEXT_FORM,
	bduk_gis: FLAG_FORM,
	bduk_gis_contract_scope: closedVocabulary(BDUKContractScope),
	bduk_gis_final_coverage_date: DATE_FORM,
	bduk_gis_contract_name: TEXT_FORM,
	bduk_gis_supplier: TEXT_FORM,
	bduk_vouchers: FLAG_FORM,
	bduk_vouchers_contract_name: TEXT_FORM,
	bduk_vouchers_supplier: TEXT_FORM,
	bduk_superfast: FLAG_FORM,
	bduk_superfast_contract_name: TEXT_FORM,
	bduk_superfast_supplier: TEXT_FORM,
	bduk_hubs: FLAG_FORM,
	bduk_hubs_contract_name: TEXT_FORM,
	bduk_hubs_supplier: TEXT_FORM,
}

/**
 * A UPRN has up to 12 digits, so every one is a safe integer.
 */
const UPRN_FORM = /^[1-9]\d{0,11}$/u

/**
 * The file a set of rows came from, with the facts its name states.
 */
export interface BDUKReleaseSource {
	/**
	 * The file name as published, such as `202605_BDUK_uprn_release_london_croydon.csv`.
	 */
	readonly file: string
	/**
	 * The OMR month from the name's `YYYYMM` prefix, as `YYYY-MM`.
	 */
	readonly release: string
	/**
	 * The name between `uprn_release_` and `.csv`: a region and a local authority
	 * district such as `london_croydon`, or `sample`.
	 */
	readonly part: string
}

/**
 * One premises' requested values.
 */
export interface BDUKRow<C extends BDUKColumn> {
	readonly uprn: number
	readonly file: string
	/**
	 * The row's line in its file, with the header on line 1.
	 */
	readonly line: number
	readonly values: { readonly [K in C]: BDUKColumnValues[K] }
}

/**
 * Which rows a read returns.
 */
export interface BDUKRowSelection {
	/**
	 * Return only the rows whose postcode is one of these, written as the release writes a postcode.
	 *
	 * The reader still reads and checks every row.
	 */
	readonly postcodes?: Iterable<string>
}

/**
 * A parsed file: its source facts, the count of rows it holds and the selected rows.
 */
export interface BDUKReleaseFile<C extends BDUKColumn> {
	readonly source: BDUKReleaseSource
	/**
	 * The file's data rows.
	 * The reader checked each one against the requested columns.
	 */
	readonly rowCount: number
	/**
	 * The selected rows in file order.
	 */
	readonly rows: readonly BDUKRow<C>[]
}

/**
 * Requested columns that a file's header does not name.
 */
export class BDUKColumnError extends Error {
	readonly file: string
	readonly columns: readonly string[]

	constructor(file: string, columns: readonly string[]) {
		super(`${file} has no column for ${columns.map((column) => `"${column}"`).join(", ")}.`)

		this.name = "BDUKColumnError"
		this.file = file
		this.columns = columns
	}
}

/**
 * A cell outside its column's vocabulary or form.
 */
export class BDUKValueError extends Error {
	readonly file: string
	readonly line: number
	/**
	 * The row's UPRN as written, or `null` when the UPRN cell itself is the refused value.
	 */
	readonly uprn: string | null
	readonly column: string
	readonly value: string

	constructor(cell: {
		file: string
		line: number
		uprn: string | null
		column: string
		value: string
		expected: string
	}) {
		const row = cell.uprn === null ? `line ${cell.line}` : `line ${cell.line}, UPRN ${cell.uprn}`

		super(`${cell.file} ${row}: "${cell.column}" holds ${stringifyJSON(cell.value)}, which is not ${cell.expected}.`)

		this.name = "BDUKValueError"
		this.file = cell.file
		this.line = cell.line
		this.uprn = cell.uprn
		this.column = cell.column
		this.value = cell.value
	}
}

/**
 * The published file-name shape: an OMR month, the release's fixed words and the file's part.
 */
const FILE_NAME = /^(?<year>\d{4})(?<month>0[1-9]|1[0-2])_BDUK_uprn_release_(?<part>.+)\.csv$/u

/**
 * Derives the source facts from a published file name, or throws when the name does not state them.
 */
export function parseBDUKReleaseFileName(file: string): BDUKReleaseSource {
	const groups = FILE_NAME.exec(file)?.groups

	if (!groups) {
		throw new Error(
			`${file} is not a BDUK UPRN-level release file name such as 202605_BDUK_uprn_release_london_croydon.csv; ` +
				`its OMR month cannot be read from it.`
		)
	}

	return { file, release: `${groups["year"]}-${groups["month"]}`, part: groups["part"]! }
}

/**
 * Parses the text of one release file and returns the requested columns of the selected rows.
 *
 * The file's name must be the published one, because the OMR month is stated nowhere else.
 *
 * @throws {BDUKColumnError} When the header lacks `uprn`, a requested column,
 * or `postcode` for a postcode selection.
 * @throws {BDUKValueError} When a requested cell, or a UPRN, is outside its column's vocabulary or form.
 * @throws When the file is empty, the header repeats a label, a row's width differs from
 * the header's, a UPRN repeats, or the parsed row count differs from the file's line count.
 */
export function parseBDUKRelease<const C extends BDUKColumn>(
	text: string,
	file: string,
	columns: readonly C[],
	selection: BDUKRowSelection = {}
): BDUKReleaseFile<C> {
	const source = parseBDUKReleaseFileName(file)
	const records = CSVSpliterator.from(text, { mode: "array", header: false })[Symbol.iterator]()
	const first = records.next()

	if (first.done) throw new Error(`${file} is empty.`)

	const header = first.value as string[]
	const indices = headerColumnIndex(file, header)
	const postcodes = selection.postcodes ? new Set(selection.postcodes) : null

	const needed: string[] = [BDUK_UPRN_COLUMN, ...columns, ...(postcodes ? ["postcode"] : [])]
	const missing = [...new Set(needed)].filter((column) => !indices.has(column))

	if (missing.length) throw new BDUKColumnError(file, missing)

	const uprnIndex = indices.get(BDUK_UPRN_COLUMN)!
	const postcodeIndex = indices.get("postcode")
	const requested = columns.map((column) => [column, indices.get(column)!, COLUMN_FORMS[column]] as const)
	const lineOfUPRN = new Map<number, number>()
	const rows: BDUKRow<C>[] = []
	let line = 1

	for (let next = records.next(); !next.done; next = records.next()) {
		const record = next.value as string[]

		line++

		if (record.length !== header.length) {
			throw new Error(`${file} line ${line} has ${record.length} columns where the header has ${header.length}.`)
		}

		const uprnCell = record[uprnIndex]!

		if (!UPRN_FORM.test(uprnCell)) {
			throw new BDUKValueError({
				file,
				line,
				uprn: null,
				column: BDUK_UPRN_COLUMN,
				value: uprnCell,
				expected: "a UPRN of 1 to 12 digits",
			})
		}

		const uprn = Number(uprnCell)
		const earlier = lineOfUPRN.get(uprn)

		if (earlier !== undefined) throw new Error(`${file} line ${line} repeats UPRN ${uprn} from line ${earlier}.`)

		lineOfUPRN.set(uprn, line)

		const values: Partial<Record<C, unknown>> = {}

		for (const [column, index, form] of requested) {
			const cell = record[index]!

			if (cell === "") {
				values[column] = null

				continue
			}

			const value = form.read(cell)

			if (value === undefined) {
				throw new BDUKValueError({ file, line, uprn: uprnCell, column, value: cell, expected: form.expected })
			}

			values[column] = value
		}

		if (postcodes && !postcodes.has(record[postcodeIndex!]!)) continue

		rows.push({ uprn, file, line, values: values as BDUKRow<C>["values"] })
	}

	const rowCount = line - 1

	checkRecordCount(file, text, rowCount)

	return { source, rowCount, rows }
}

/**
 * Reads one release file from disk under its published name.
 *
 * @see {@linkcode parseBDUKRelease} for the checks and the errors.
 */
export async function readBDUKReleaseFile<const C extends BDUKColumn>(
	path: PathBuilderLike,
	columns: readonly C[],
	selection: BDUKRowSelection = {}
): Promise<BDUKReleaseFile<C>> {
	return parseBDUKRelease(await readLocalTextFile(path), basename(path.toString()), columns, selection)
}

/**
 * A directory of release files read together: each file read, the count of rows
 * in all of them and the selected rows.
 */
export interface BDUKReleaseDirectory<C extends BDUKColumn> {
	/**
	 * The OMR month that every file's name states.
	 */
	readonly release: string
	/**
	 * Each file read, in name order, with its count of data rows.
	 */
	readonly files: readonly (BDUKReleaseSource & { readonly rowCount: number })[]
	readonly rowCount: number
	/**
	 * The selected rows of every file, in name order and then file order.
	 */
	readonly rows: readonly BDUKRow<C>[]
}

/**
 * Reads every CSV file directly inside a directory, such as one region's extracted files.
 *
 * Each file must state the same OMR month.
 * A selected UPRN that appears in two files throws, so a count over the selected
 * rows counts each premises once.
 *
 * @throws When the directory holds no CSV file, or for any refusal of {@linkcode parseBDUKRelease}.
 */
export async function readBDUKReleaseDirectory<const C extends BDUKColumn>(
	directory: PathBuilderLike,
	columns: readonly C[],
	selection: BDUKRowSelection = {}
): Promise<BDUKReleaseDirectory<C>> {
	const names = await Globerator.from("*.csv", { cwd: directory.toString(), absolute: false }).toSorted()

	if (!names.length) throw new Error(`${directory.toString()} holds no CSV file.`)

	const files: (BDUKReleaseSource & { rowCount: number })[] = []
	const rows: BDUKRow<C>[] = []
	const placeOfUPRN = new Map<number, BDUKRow<C>>()

	for (const name of names) {
		const read = await readBDUKReleaseFile(PathBuilder.from(directory)(name), columns, selection)
		const release = files[0]?.release

		if (release !== undefined && read.source.release !== release) {
			throw new Error(
				`${directory.toString()} mixes releases: ${name} is ${read.source.release} where the other files are ${release}.`
			)
		}

		for (const row of read.rows) {
			const earlier = placeOfUPRN.get(row.uprn)

			if (earlier) {
				throw new Error(
					`UPRN ${row.uprn} is in ${earlier.file} line ${earlier.line} and in ${row.file} line ${row.line}.`
				)
			}

			placeOfUPRN.set(row.uprn, row)
			rows.push(row)
		}

		files.push({ ...read.source, rowCount: read.rowCount })
	}

	return {
		release: files[0]!.release,
		files,
		rowCount: files.reduce((total, file) => total + file.rowCount, 0),
		rows,
	}
}
