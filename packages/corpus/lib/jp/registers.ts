/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The National Tax Agency's corporate-number register (法人番号公表サイト 全件データ) as a noisy corpus source.
 *
 *   The nationwide CSV fields each domestic address into 都道府県, 市区町村 and 丁目番地等, with a seven-digit
 *   郵便番号. The first two are register names that align to the Overture-JP admin ladder by exact lookup. The third
 *   is the typed part (`柏木町４－７`, `霞が関３丁目１番１号`, `末広町１８４ ビル名 ３Ｆ`).
 *
 *   Alignment needs the (prefecture, municipality) pair to be an Overture key and the leading name of 丁目番地等 to
 *   be a district that municipality lists. Spans sit on the raw typed string, so a noisy row keeps the surface a
 *   person typed: `block` for a trailing 丁目, `house_number` for the number as typed (a designator form `N番N号`
 *   whole), `building_name` for the remainder, and `postcode` when the row is rendered with a 〒 prefix.
 *
 *   Ported from the Python builders' `countries/jp/registers.py`. Offsets are code points.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { readZipEntry } from "@mailwoman/core/fs/zip"
import { pythonIsDigit, pythonSplitWhitespace, pythonStrip } from "@mailwoman/core/strings/python-text"
import type { PathBuilderLike } from "path-ts"
import { CSVSpliterator } from "spliterator"

import { addToKeySet, type CJKRecord, codePointLength, labelTokensByFirstSpan, unitKey } from "#cjk/builder"
import { JP_PREFECTURE_NAMES, normalizeJPName, splitJPStreet } from "#jp/text"
import { parquetRowGroupRows } from "#parquet/readers"
import { openParquetRowStream } from "#parquet/streams"

/**
 * The corpus source of the register's rows.
 */
export const JP_REGISTRY_SOURCE = "houjin-jp"

const COUNTRY = "JP"

/**
 * The hold-out bucket from which a Japanese municipality is a board unit: buckets 97 to 99 of 100.
 */
export const JP_BOARD_BUCKET_MIN = 97

// Column positions in the nationwide CSV (リソース定義書 4.1: 7 商号, 9 法人種別, 10 都道府県,
// 11 市区町村, 12 丁目番地等, 16 郵便番号, counted from 1).
const COL_NAME = 6
const COL_KIND = 8
const COL_PREFECTURE = 9
const COL_MUNICIPALITY = 10
const COL_STREET = 11
const COL_POSTCODE = 15

const DIGITS = "0-9０-９"
const KANJI_NUMERAL = "〇一二三四五六七八九十百"
const HYPHENS = "-－‐‑‒–—―−ー﹘﹣ｰ"

// The numeric tail of 丁目番地等: an optional chōme, then a number in either register, then whatever follows.
const TAIL_SHAPE = new RegExp(
	`^(?<chome>[${DIGITS}${KANJI_NUMERAL}]+丁目)?` +
		`(?<number>(?:[${DIGITS}]+(?:番地?|号)?)(?:[${HYPHENS}][${DIGITS}]+(?:番地?|号)?)*)?` +
		"(?<rest>.*)$",
	"u"
)

const TAIL_START = new RegExp(`[${DIGITS}${KANJI_NUMERAL}]`, "gu")

/**
 * 丁目番地等 split into district, chōme, number and remainder, at the leftmost numeral
 * whose prefix is a district the register lists and whose tail parses as a chōme
 * and then a number, or `null` when none does.
 *
 * A district name may hold a kanji numeral (`一条通北２丁目３－２５`), so every numeral position is tried in order.
 */
export function splitTypedStreet(
	street: string,
	districts: ReadonlySet<string>
): readonly [district: string, chome: string, number: string, rest: string] | null {
	for (const match of street.matchAll(TAIL_START)) {
		const district = street.slice(0, match.index)

		if (!district || !districts.has(normalizeJPName(district))) continue

		const tail = TAIL_SHAPE.exec(street.slice(match.index))

		if (!tail) continue

		const chome = tail.groups?.["chome"] ?? ""
		const number = tail.groups?.["number"] ?? ""

		if (!chome && !number) continue

		return [district, chome, number, tail.groups?.["rest"] ?? ""]
	}

	return null
}

/**
 * The districts Overture lists under each (prefecture, municipality),
 * from the parquet the label corpus reads.
 */
export class JPKeyIndex {
	readonly districtsByUnit = new Map<string, Set<string>>()

	/**
	 * The districts listed under one unit, if any.
	 */
	districts(prefecture: string, municipality: string): ReadonlySet<string> | undefined {
		return this.districtsByUnit.get(unitKey(prefecture, municipality))
	}

	/**
	 * Builds the index from an Overture-JP parquet file, or from its first `maxRowGroups` row groups.
	 *
	 * @throws When the file is missing.
	 */
	static async fromParquet(parquet: PathBuilderLike, maxRowGroups?: number): Promise<JPKeyIndex> {
		const limit = typeof maxRowGroups === "number" ? await parquetRowGroupRows(parquet, maxRowGroups) : undefined
		const index = new JPKeyIndex()

		interface Row {
			address_levels: Array<{ value: string | null }> | null
			street: string | null
		}

		for await (const row of openParquetRowStream<Row>(parquet, { columns: ["address_levels", "street"], limit })) {
			const level = row.address_levels

			if (!level || level.length < 2 || !row.street) continue

			const prefecture = level[0]!.value
			const municipality = level[1]!.value

			if (!prefecture || !JP_PREFECTURE_NAMES.has(prefecture) || !municipality) continue

			const [district] = splitJPStreet(normalizeJPName(row.street))

			if (!district) continue

			addToKeySet(index.districtsByUnit, unitKey(prefecture, municipality), district)
		}

		return index
	}
}

/**
 * One corporation with a domestic address.
 */
export interface CorporateRow {
	name: string
	kind: string
	prefecture: string
	municipality: string
	street: string
	postcode: string
}

/**
 * Streams the nationwide CSV out of its zip, one row per corporation with all three address fields.
 *
 * @throws When the zip is missing, naming it, or holds no CSV member.
 */
export async function* iterCorporateRows(zipPath: PathBuilderLike): AsyncGenerator<CorporateRow> {
	if (!(await pathExists(zipPath))) throw new Error(`No corporate-number register zip at ${zipPath.toString()}`)

	for await (const cells of CSVSpliterator.fromAsync<string[]>(readZipEntry(zipPath, /\.csv$/u), { header: false })) {
		if (cells.length <= COL_POSTCODE) continue

		const prefecture = String(cells[COL_PREFECTURE] ?? "")
		const municipality = String(cells[COL_MUNICIPALITY] ?? "")
		const street = String(cells[COL_STREET] ?? "")

		if (!prefecture || !municipality || !street) continue

		yield {
			name: String(cells[COL_NAME] ?? ""),
			kind: String(cells[COL_KIND] ?? ""),
			prefecture,
			municipality,
			street,
			postcode: String(cells[COL_POSTCODE] ?? ""),
		}
	}
}

/**
 * A register row rendered and spanned.
 */
export interface JPAligned {
	raw: string
	span_starts: number[]
	span_ends: number[]
	span_tags: string[]
	register: string
	prefecture: string
	municipality: string
}

const POSTCODE_DIGITS = 7
const POSTCODE_SPLIT = 3

/**
 * The three fields rendered as the one line a person types, with spans placed on it,
 * or `null` when they do not align.
 */
export function alignCorporateRow(row: CorporateRow, index: JPKeyIndex, withPostcode = false): JPAligned | null {
	const districts = index.districts(row.prefecture, row.municipality)

	if (!districts?.size) return null

	const split = splitTypedStreet(pythonSplitWhitespace(row.street).join(""), districts)

	if (!split) return null

	const [district, chome, number, rest] = split

	const aligned: JPAligned = {
		raw: "",
		span_starts: [],
		span_ends: [],
		span_tags: [],
		register: "registry",
		prefecture: row.prefecture,
		municipality: row.municipality,
	}

	let length = 0

	const glue = (text: string) => {
		aligned.raw += text
		length += codePointLength(text)
	}

	const put = (tag: string, text: string) => {
		aligned.span_starts.push(length)
		aligned.span_ends.push(length + codePointLength(text))
		aligned.span_tags.push(tag)
		glue(text)
	}

	if (withPostcode && codePointLength(row.postcode) === POSTCODE_DIGITS && pythonIsDigit(row.postcode)) {
		glue("〒")
		put("postcode", `${row.postcode.slice(0, POSTCODE_SPLIT)}-${row.postcode.slice(POSTCODE_SPLIT)}`)
		glue(" ")
	}

	put("prefecture", row.prefecture)
	put("municipality", row.municipality)
	put("district", district)

	if (chome) {
		put("block", chome)
	}

	if (number) {
		put("house_number", number)
	}

	const building = pythonStrip(rest)

	if (building) {
		put("building_name", building)
	}

	return aligned
}

/**
 * An aligned row as a corpus record.
 *
 * Each whitespace token is labeled with the span it starts in.
 */
export function jpRegistryRecord(aligned: JPAligned): CJKRecord {
	const { raw } = aligned

	return {
		raw,
		...labelTokensByFirstSpan(raw, aligned.span_starts, aligned.span_ends, aligned.span_tags),
		span_starts: [...aligned.span_starts],
		span_ends: [...aligned.span_ends],
		span_tags: [...aligned.span_tags],
		country: COUNTRY,
		source: JP_REGISTRY_SOURCE,
		register: aligned.register,
	}
}
