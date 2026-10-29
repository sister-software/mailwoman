/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Routes CJK-script place rows of non-CJK countries into the CJK family's training corpus (#2846).
 *
 *   The wof-admin adapter writes each place's hierarchy in every preferred-name language, so
 *   `ニューヨーク州ブルックリン区` and `뉴욕 주 브루클린` are rows of country US. This builder reads a corpus
 *   parquet file, keeps every row of a country outside {@linkcode CJK_COUNTRIES} whose letters are at
 *   least {@linkcode MIN_CJK_SHARE} Han, Kana or Hangul, and writes them as a versioned corpus in the CJK
 *   schema: `train/` and `val/` parts, a sealed character vocabulary and a manifest. The overlay takes
 *   the result as an extra corpus. A row's split comes from the split attribute the corpus build wrote,
 *   and test rows stay out.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { countInto, mostCommon } from "@mailwoman/core/stats"
import { pythonJSONDumps } from "@mailwoman/core/strings/python-json"
import { basename, resolvePath } from "path-ts"

import {
	buildCharVocab,
	CJK_LABEL_SET_NAME,
	type CJKRecord,
	directoryHasEntries,
	readLabelSetTags,
	RecordCheckError,
	saveCharVocab,
	verifyCJKRecord,
	writeCJKCorpusParquet,
} from "#cjk/builder"
import { openParquetRowStream } from "#parquet/streams"
import { pythonRepr } from "#training/config/python-yaml"

/**
 * Countries whose rows the CJK family already reads from its own sources.
 */
export const CJK_COUNTRIES: ReadonlySet<string> = new Set(["JP", "CN", "TW", "HK", "MO", "KR", "KP"])

/**
 * The least share of a row's letters in Han, Kana or Hangul for the row to route to the CJK family.
 *
 * A localized hierarchy is written wholly in its language, so its share is 1.0.
 * A row that keeps a Latin ancestor (`フェアモント, WV`) mixes scripts and stays with
 * the family its address body's script selects.
 */
export const MIN_CJK_SHARE = 0.9

/**
 * The corpus source the rows keep, so the source register and rights records already cover them.
 */
export const FOREIGN_PLACES_SOURCE = "wof-admin"

/**
 * The register every routed row carries.
 */
export const FOREIGN_PLACES_REGISTER = "wof-foreign-cjk"

/**
 * The letters whose Unicode 15.0 name begins `CJK UNIFIED`, `CJK COMPATIBILITY`,
 * `HIRAGANA`, `KATAKANA` or `HANGUL`, as inclusive code-point ranges.
 *
 * JavaScript exposes no character names, so the table is frozen from CPython 3.12's
 * `unicodedata` (Unicode 15.0), the set the Python builder counted.
 * Halfwidth katakana and halfwidth Hangul are named `HALFWIDTH …` and are not in it.
 */
const CJK_LETTER_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0x11_00, 0x11_ff],
	[0x30_41, 0x30_96],
	[0x30_9d, 0x30_9f],
	[0x30_a1, 0x30_fa],
	[0x30_fc, 0x30_ff],
	[0x31_31, 0x31_8e],
	[0x31_f0, 0x31_ff],
	[0x34_00, 0x4d_bf],
	[0x4e_00, 0x9f_ff],
	[0xa9_60, 0xa9_7c],
	[0xac_00, 0xd7_a3],
	[0xd7_b0, 0xd7_c6],
	[0xd7_cb, 0xd7_fb],
	[0xf9_00, 0xfa_6d],
	[0xfa_70, 0xfa_d9],
	[0x1_af_f0, 0x1_af_f3],
	[0x1_af_f5, 0x1_af_fb],
	[0x1_af_fd, 0x1_af_fe],
	[0x1_b0_00, 0x1_b0_01],
	[0x1_b1_1f, 0x1_b1_22],
	[0x1_b1_32, 0x1_b1_32],
	[0x1_b1_50, 0x1_b1_52],
	[0x1_b1_55, 0x1_b1_55],
	[0x1_b1_64, 0x1_b1_67],
	[0x2_00_00, 0x2_a6_df],
	[0x2_a7_00, 0x2_b7_39],
	[0x2_b7_40, 0x2_b8_1d],
	[0x2_b8_20, 0x2_ce_a1],
	[0x2_ce_b0, 0x2_eb_e0],
	[0x2_f8_00, 0x2_fa_1d],
	[0x3_00_00, 0x3_13_4a],
	[0x3_13_50, 0x3_23_af],
]

const LETTER = /^\p{L}$/u

const isCJKLetter = (codePoint: number): boolean =>
	CJK_LETTER_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high)

/**
 * The share of `text`'s letters that are Han, Kana or Hangul, or 0 for a text with no letter.
 *
 * A letter is a character of general category `L`, Python's `str.isalpha`.
 * Node's Unicode tables are newer than Python 3.12's, so a letter assigned
 * after Unicode 15.0 counts as a non-CJK letter here.
 */
export function cjkShare(text: string): number {
	let letters = 0
	let cjk = 0

	for (const character of text) {
		if (!LETTER.test(character)) continue

		letters++

		if (isCJKLetter(character.codePointAt(0)!)) {
			cjk++
		}
	}

	return letters ? cjk / letters : 0
}

/**
 * Whether a row is a CJK-script place row of a country outside {@linkcode CJK_COUNTRIES}.
 */
export function isForeignCJKRow(row: { raw: string; country: string }): boolean {
	return !CJK_COUNTRIES.has(row.country) && cjkShare(row.raw) >= MIN_CJK_SHARE
}

/**
 * Each wanted UTF-16 offset into `text` mapped to its code-point index.
 *
 * @throws When an offset falls inside a surrogate pair or past the end, naming the offsets that miss.
 */
export function utf16Boundaries(text: string, offsets: Iterable<number>): Map<number, number> {
	const wanted = new Set(offsets)
	const result = new Map<number, number>()
	let units = 0
	let index = 0

	if (wanted.has(0)) {
		result.set(0, 0)
	}

	for (const character of text) {
		index++
		units += character.length

		if (wanted.has(units)) {
			result.set(units, index)
		}
	}

	const missing = [...wanted].filter((offset) => !result.has(offset)).toSorted((a, b) => a - b)

	if (missing.length) {
		throw new Error(`span offsets are not UTF-16 boundaries for ${pythonRepr(text)}: [${missing.join(", ")}]`)
	}

	return result
}

/**
 * One corpus row as the builder reads it.
 */
export interface ForeignPlaceRow {
	raw: string
	tokens: string[]
	labels: string[]
	span_starts: number[]
	span_ends: number[]
	span_tags: string[]
	country: string
	source_id: string
}

const ROW_COLUMNS = ["raw", "tokens", "labels", "span_starts", "span_ends", "span_tags", "country", "source_id"]

/**
 * The CJK-schema record of one corpus row, its span offsets moved from UTF-16 units to code points.
 */
export function toForeignPlaceRecord(row: ForeignPlaceRow): CJKRecord {
	const starts = row.span_starts.map(Number)
	const ends = row.span_ends.map(Number)
	const boundaries = utf16Boundaries(row.raw, [...starts, ...ends])

	return {
		raw: row.raw,
		tokens: [...row.tokens],
		labels: [...row.labels],
		span_starts: starts.map((start) => boundaries.get(start)!),
		span_ends: ends.map((end) => boundaries.get(end)!),
		span_tags: [...row.span_tags],
		country: row.country,
		source: FOREIGN_PLACES_SOURCE,
		register: FOREIGN_PLACES_REGISTER,
	}
}

/**
 * Each held-out `source_id` mapped to `val` or `test`, from a split attribute
 * file `corpus split-overlay` wrote.
 * An id listed under both is `test`.
 *
 * @throws When the file is missing or lacks either list.
 */
export async function heldOutIDs(splitAttribute: string): Promise<Map<string, string>> {
	const attribute = await readLocalJSONFile<{ val?: string[]; test?: string[] }>(splitAttribute)
	const held = new Map<string, string>()

	for (const split of ["val", "test"] as const) {
		const ids = attribute[split]

		if (!Array.isArray(ids)) throw new Error(`split attribute ${splitAttribute} has no ${split} list`)

		for (const id of ids) {
			held.set(id, split)
		}
	}

	return held
}

/**
 * Options for {@linkcode buildForeignPlaces}.
 */
export interface ForeignPlacesOptions {
	parquet: string
	splitAttribute: string
	outDir: string
	force?: boolean
}

/**
 * Writes the foreign-place CJK corpus and returns its build report.
 *
 * A row the record check refuses is counted under the defect's kind and left out.
 *
 * @throws When `outDir` holds a file and `force` is unset, an input is missing, or no row routes to train.
 */
export async function buildForeignPlaces(options: ForeignPlacesOptions): Promise<Map<string, unknown>> {
	const { parquet, splitAttribute, outDir } = options

	if (!options.force && (await directoryHasEntries(outDir))) {
		throw new Error(`${outDir} is not empty; pass --force to overwrite`)
	}

	if (!(await pathExists(parquet))) throw new Error(`No parquet file at ${parquet}`)

	const tagSet = await readLabelSetTags(CJK_LABEL_SET_NAME)
	const held = await heldOutIDs(splitAttribute)
	const bySplit = { train: [] as CJKRecord[], val: [] as CJKRecord[] }
	const countries = new Map<string, number>()
	const refused = new Map<string, number>()
	let testRows = 0

	for await (const row of openParquetRowStream<ForeignPlaceRow>(parquet, { columns: ROW_COLUMNS })) {
		if (!isForeignCJKRow(row)) continue

		const split = held.get(row.source_id) ?? "train"

		if (split === "test") {
			testRows++

			continue
		}

		const record = toForeignPlaceRecord(row)

		try {
			verifyCJKRecord(record, tagSet)
		} catch (error) {
			if (!(error instanceof RecordCheckError)) throw error

			countInto(refused, error.message.split(":", 1)[0]!)

			continue
		}

		bySplit[split === "val" ? "val" : "train"].push(record)
		countInto(countries, row.country)
	}

	if (!bySplit.train.length) throw new Error(`${parquet} holds no CJK-script row of a non-CJK country`)

	const partName = `${FOREIGN_PLACES_SOURCE}-0000.parquet`

	for (const [split, records] of Object.entries(bySplit)) {
		await makeDirectories(resolvePath(outDir, split))

		if (records.length) {
			await writeCJKCorpusParquet(records, resolvePath(outDir, split, partName), "foreign-place CJK build")
		}
	}

	await saveCharVocab(
		buildCharVocab(
			bySplit.train.map((record) => record.raw),
			2
		),
		resolvePath(outDir, "char-vocab-foreign.json")
	)

	const countryList = [...CJK_COUNTRIES].toSorted().map((country) => `'${country}'`)

	const manifest = new Map<string, unknown>([
		["corpus_version", basename(outDir)],
		["label_set", CJK_LABEL_SET_NAME],
		[
			"note",
			`CJK-script rows of countries outside [${countryList.join(", ")}] from ${basename(parquet)}, for the CJK family.`,
		],
		[
			"files",
			Object.entries(bySplit)
				.filter(([, records]) => records.length)
				.map(
					([split]) =>
						new Map([
							// The path as the caller wrote `outDir`, relative or absolute, as the Python builder joined it.
							["path", `${outDir.replace(/\/+$/, "")}/${split}/${partName}`],
							["split", split],
							["source", FOREIGN_PLACES_SOURCE],
						])
				),
		],
	])

	await writeLocalTextFile(
		pythonJSONDumps(manifest, { indent: 2, ensureASCII: false }) + "\n",
		resolvePath(outDir, "MANIFEST.json")
	)

	const report = new Map<string, unknown>([
		["parquet", parquet],
		["split_attribute", splitAttribute],
		[
			"rows",
			new Map([
				["train", bySplit.train.length],
				["val", bySplit.val.length],
			]),
		],
		["test_rows_left_out", testRows],
		["refused", refused],
		["countries", new Map(mostCommon(countries))],
	])

	await writeLocalTextFile(
		pythonJSONDumps(report, { indent: 2, ensureASCII: false }) + "\n",
		resolvePath(outDir, "build-report.json")
	)

	return report
}
