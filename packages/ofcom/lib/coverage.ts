/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reader for Ofcom's Connected Nations fixed-coverage files at postcode and census output-area level.
 *
 *   Each row describes all premises that Ofcom's premises base assigns to one area. A row is therefore
 *   area context, and it states no result for any building inside the area. Ofcom names no network at
 *   either level and withholds full-fiber availability at both.
 *
 *   A postcode file publishes percentages only. Ofcom's guide lists `All Premises`, `All Matched Premises`
 *   and every `Number of premises…` field as present in "all except pc", so a postcode row has no
 *   premises denominator. The output-area file is the finest level that publishes one. A request for a
 *   field the file lacks throws {@linkcode OfcomCoverageFieldError} rather than returning an absent value.
 *
 *   The snapshot month, the premises set and the revision appear only in the published file name.
 *   The reader therefore requires that name and derives all three from it.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import { basename, type PathBuilderLike } from "path-ts"
import { CSVSpliterator, TextSpliterator } from "spliterator"

/**
 * The two levels this reader accepts.
 */
export const OfcomCoverageLevel = {
	/**
	 * One row per unit postcode, keyed by `postcode_space`.
	 */
	Postcode: "postcode",
	/**
	 * One row per census output area (2021 in England, Wales and Northern Ireland,
	 * 2022 in Scotland), keyed by `output_area`.
	 */
	OutputArea: "output-area",
} as const

export type OfcomCoverageLevel = (typeof OfcomCoverageLevel)[keyof typeof OfcomCoverageLevel]

/**
 * The premises a file counts: residential and commercial premises together, or only residential premises.
 */
export const OfcomPremisesSet = {
	All: "all",
	Residential: "residential",
} as const

export type OfcomPremisesSet = (typeof OfcomPremisesSet)[keyof typeof OfcomPremisesSet]

/**
 * The value columns of Ofcom's fixed-coverage files, each mapped to its published header label.
 *
 * The labels are Ofcom's own, verbatim from the January 2026 files.
 * A postcode file has the seventeen percentage fields.
 *
 * An output-area file has those, the two premises counts and the seventeen matching counts of premises.
 */
export const OfcomCoverageField = {
	AllPremises: "All Premises",
	AllMatchedPremises: "All Matched Premises",
	SuperfastPercent: "SFBB availability (% premises)",
	Ultrafast100Percent: "UFBB (100Mbit/s) availability (% premises)",
	Ultrafast300Percent: "UFBB availability (% premises)",
	GigabitPercent: "Gigabit availability (% premises)",
	NextGenerationAccessPercent: "% of premises with NGA",
	NoDecentBroadbandPercent: "% of premises unable to receive decent broadband from fixed or FWA",
	FixedWirelessDecentPercent: "% of premises able to receive decent broadband from FWA",
	Below2Percent: "% of premises unable to receive 2Mbit/s",
	Below5Percent: "% of premises unable to receive 5Mbit/s",
	Below10Percent: "% of premises unable to receive 10Mbit/s",
	Below30Percent: "% of premises unable to receive 30Mbit/s",
	Max0To2Percent: "% of premises with 0<2Mbit/s download speed",
	Max2To5Percent: "% of premises with 2<5Mbit/s download speed",
	Max5To10Percent: "% of premises with 5<10Mbit/s download speed",
	Max10To30Percent: "% of premises with 10<30Mbit/s download speed",
	Max30To300Percent: "% of premises with 30<300Mbit/s download speed",
	Max300PlusPercent: "% of premises with >=300Mbit/s download speed",
	SuperfastPremises: "Number of premises with SFBB availability",
	Ultrafast100Premises: "Number of premises with UFBB (100Mbit/s) availability",
	Ultrafast300Premises: "Number of premises with UFBB availability",
	GigabitPremises: "Number of premises with Gigabit availability",
	NextGenerationAccessPremises: "Number of premises with NGA",
	NoDecentBroadbandPremises: "Number of premises unable to receive decent broadband from fixed or FWA",
	FixedWirelessDecentPremises: "Number of premises able to receive decent broadband from FWA",
	Below2Premises: "Number of premises unable to receive 2Mbit/s",
	Below5Premises: "Number of premises unable to receive 5Mbit/s",
	Below10Premises: "Number of premises unable to receive 10Mbit/s",
	Below30Premises: "Number of premises unable to receive 30Mbit/s",
	Max0To2Premises: "Number of premises with 0<2Mbit/s download speed",
	Max2To5Premises: "Number of premises with 2<5Mbit/s download speed",
	Max5To10Premises: "Number of premises with 5<10Mbit/s download speed",
	Max10To30Premises: "Number of premises with 10<30Mbit/s download speed",
	Max30To300Premises: "Number of premises with 30<300Mbit/s download speed",
	Max300PlusPremises: "Number of premises with >=300Mbit/s download speed",
} as const

export type OfcomCoverageField = (typeof OfcomCoverageField)[keyof typeof OfcomCoverageField]

/**
 * The file a set of rows came from, with the facts its name states.
 */
export interface OfcomCoverageSource {
	/**
	 * The file name as published inside Ofcom's ZIP, such as `202601_fixed_pc_coverage_r2_CR.csv`.
	 */
	readonly file: string
	/**
	 * The snapshot month from the name's `YYYYMM` prefix, as `YYYY-MM`.
	 */
	readonly snapshot: string
	/**
	 * The revision from the name's `r` token.
	 *
	 * Ofcom's version 2 of 2026-07-07 reissued the all-premises postcode files as revision 2.
	 */
	readonly revision: number
	readonly level: OfcomCoverageLevel
	readonly premises: OfcomPremisesSet
	/**
	 * The postcode area a postcode file covers, such as `CR`.
	 * An output-area file covers the UK and has none.
	 */
	readonly postcodeArea: string | null
}

/**
 * One area's published values for the requested fields.
 */
export interface OfcomCoverageRow<F extends OfcomCoverageField> {
	/**
	 * The row describes every premises in the area together and is never a result for one building.
	 */
	readonly scope: "area"
	readonly level: OfcomCoverageLevel
	/**
	 * The postcode with its single space, such as `CR0 5BX`, or the output-area code, such as `E00005233`.
	 */
	readonly area: string
	readonly premises: OfcomPremisesSet
	readonly snapshot: string
	readonly file: string
	/**
	 * Each requested field's value as published: a percentage of the area's premises, or a count of them.
	 */
	readonly values: Readonly<Record<F, number>>
}

/**
 * A parsed file: its source facts and one row per area, keyed by {@linkcode OfcomCoverageRow.area}.
 *
 * An area with no row is an area the file does not report.
 * That case differs from an area whose premises have no coverage.
 */
export interface OfcomCoverageFile<F extends OfcomCoverageField> {
	readonly source: OfcomCoverageSource
	readonly rows: ReadonlyMap<string, OfcomCoverageRow<F>>
}

/**
 * A requested field that the file does not publish.
 */
export class OfcomCoverageFieldError extends Error {
	readonly file: string
	readonly level: OfcomCoverageLevel
	readonly fields: readonly OfcomCoverageField[]

	constructor(file: string, level: OfcomCoverageLevel, fields: readonly OfcomCoverageField[]) {
		const premisesNote =
			level === OfcomCoverageLevel.Postcode
				? " Ofcom publishes premises counts from output-area level upward and none per postcode."
				: ""

		super(
			`${file} (${level} level) has no column for ${fields.map((field) => `"${field}"`).join(", ")}.${premisesNote}`
		)

		this.name = "OfcomCoverageFieldError"
		this.file = file
		this.level = level
		this.fields = fields
	}
}

/**
 * The published file-name shape: a `YYYYMM` snapshot prefix, a level token, an optional `res`
 * token on either side of `coverage`, a revision, and a postcode area on postcode files.
 *
 * The ZIP spells the postcode token `pc` and Ofcom's guide spells it `postcode`, so both match.
 */
const FILE_NAME =
	/^(?<year>\d{4})(?<month>\d{2})_fixed_(?<level>pc|postcode|oa)_(?:(?<resBefore>res)_)?coverage_(?:(?<resAfter>res)_)?r(?<revision>\d+)(?:_(?<area>[A-Z]{1,2}))?\.csv$/

/**
 * The key columns that identify each level's rows.
 */
const POSTCODE_KEY = "postcode_space"
const POSTCODE_COMPACT = "postcode"
const POSTCODE_AREA = "postcode area"
const OUTPUT_AREA_KEY = "output_area"

/**
 * Derives the source facts from a published file name, or throws when the name does not state them.
 */
export function parseOfcomCoverageFileName(file: string): OfcomCoverageSource {
	const groups = FILE_NAME.exec(file)?.groups

	if (!groups) {
		throw new Error(
			`${file} is not an Ofcom fixed-coverage file name such as 202601_fixed_pc_coverage_r2_CR.csv; ` +
				`its snapshot, level and premises set cannot be read from it.`
		)
	}

	const level = groups["level"] === "oa" ? OfcomCoverageLevel.OutputArea : OfcomCoverageLevel.Postcode
	const postcodeArea = groups["area"] ?? null

	if (level === OfcomCoverageLevel.Postcode && !postcodeArea) {
		throw new Error(`${file} is a postcode file without a postcode-area suffix.`)
	}

	if (level === OfcomCoverageLevel.OutputArea && postcodeArea) {
		throw new Error(`${file} is an output-area file with a postcode-area suffix.`)
	}

	return {
		file,
		snapshot: `${groups["year"]}-${groups["month"]}`,
		revision: Number.parseInt(groups["revision"]!, 10),
		level,
		premises: groups["resBefore"] || groups["resAfter"] ? OfcomPremisesSet.Residential : OfcomPremisesSet.All,
		postcodeArea,
	}
}

/**
 * The column index of each label in a header row, or throws on a repeated label.
 */
function indexHeader(file: string, header: readonly string[]): Map<string, number> {
	const columns = new Map<string, number>()

	for (const [index, label] of header.entries()) {
		if (columns.has(label)) throw new Error(`${file} repeats the header column "${label}".`)

		columns.set(label, index)
	}

	return columns
}

/**
 * Parses the text of one fixed-coverage file and returns the requested fields for every area it reports.
 *
 * The file's name must be the published one, because the snapshot, premises set
 * and revision are stated nowhere else.
 * The header must hold the key columns of the level the name states.
 *
 * @throws {OfcomCoverageFieldError} When the file has no column for a requested field.
 * At postcode level this includes `All Premises`, `All Matched Premises`
 * and every `Number of premises…` field.
 * @throws When a requested value is empty or not a number, an area repeats, a row's width
 * differs from the header's, or the parsed row count differs from the file's line count.
 */
export function parseOfcomCoverage<const F extends OfcomCoverageField>(
	text: string,
	file: string,
	fields: readonly F[]
): OfcomCoverageFile<F> {
	const source = parseOfcomCoverageFileName(file)
	const [header, ...records] = CSVSpliterator.from(text, { mode: "array", header: false }).toArray()

	if (!header) throw new Error(`${file} is empty.`)

	const columns = indexHeader(file, header)
	const keyColumn = source.level === OfcomCoverageLevel.Postcode ? POSTCODE_KEY : OUTPUT_AREA_KEY
	const keyIndex = columns.get(keyColumn)

	if (keyIndex === undefined) {
		throw new Error(`${file} names a ${source.level} file, and its header has no "${keyColumn}" column.`)
	}

	const missing = fields.filter((field) => !columns.has(field))

	if (missing.length) throw new OfcomCoverageFieldError(file, source.level, missing)

	// A quoted region that never closes joins every following line into one record.
	// The file would then read short with no other sign, so the record count must match the line count.
	const lines = TextSpliterator.from(text).toArray().length

	if (records.length !== lines - 1) {
		throw new Error(`${file}: read ${records.length} records from ${lines - 1} data lines.`)
	}

	const compactIndex = columns.get(POSTCODE_COMPACT)
	const areaIndex = columns.get(POSTCODE_AREA)
	const rows = new Map<string, OfcomCoverageRow<F>>()

	for (const [offset, record] of records.entries()) {
		const line = offset + 2

		if (record.length !== header.length) {
			throw new Error(`${file} line ${line} has ${record.length} columns where the header has ${header.length}.`)
		}

		const area = record[keyIndex]!

		if (!area) throw new Error(`${file} line ${line} has an empty "${keyColumn}".`)

		if (rows.has(area)) throw new Error(`${file} line ${line} repeats the area ${area}.`)

		if (source.level === OfcomCoverageLevel.Postcode) {
			if (compactIndex !== undefined && record[compactIndex] !== area.replaceAll(" ", "")) {
				throw new Error(`${file} line ${line}: "${POSTCODE_COMPACT}" ${record[compactIndex]} disagrees with ${area}.`)
			}

			if (areaIndex !== undefined && record[areaIndex] !== source.postcodeArea) {
				throw new Error(
					`${file} line ${line}: postcode area ${record[areaIndex]} differs from the file's ${source.postcodeArea}.`
				)
			}
		}

		const values = {} as Record<F, number>

		for (const field of fields) {
			const cell = record[columns.get(field)!]!
			const value = Number(cell)

			if (cell === "" || !Number.isFinite(value)) {
				throw new Error(`${file} line ${line}, area ${area}: "${field}" holds ${stringifyJSON(cell)}, not a number.`)
			}

			values[field] = value
		}

		rows.set(area, {
			scope: "area",
			level: source.level,
			area,
			premises: source.premises,
			snapshot: source.snapshot,
			file,
			values,
		})
	}

	return { source, rows }
}

/**
 * Reads one fixed-coverage file from disk under its published name.
 *
 * @see {@linkcode parseOfcomCoverage} for the checks and the errors.
 */
export async function readOfcomCoverageFile<const F extends OfcomCoverageField>(
	path: PathBuilderLike,
	fields: readonly F[]
): Promise<OfcomCoverageFile<F>> {
	return parseOfcomCoverage(await readLocalTextFile(path), basename(path.toString()), fields)
}
