/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The Japanese corpus's two inputs: the Overture-JP parquet and KEN_ALL for the 〒 join.
 *
 *   The eligibility filter lives in the row iterator, so both build passes see the same rows. A filter applied in the
 *   second pass only would desynchronize the exact-selection masks.
 *
 *   Ported from the Python builders' `countries/jp/corpora/sources.py`.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { countInto } from "@mailwoman/core/stats"
import { codePointLength } from "@mailwoman/core/strings/code-points"
import { isDecimalDigits, splitLines } from "@mailwoman/core/strings/unicode"
import type { PathBuilderLike } from "path-ts"

import { MAX_FIELD_CHARS } from "#cjk/builder"
import { decodeCP932, normalizeCJKText } from "#cjk/text"
import { JP_PREFECTURE_NAMES, normalizeJPName, normalizeJPNumber } from "#jp/text"
import { parquetRowGroupRows } from "#parquet/readers"
import { openParquetRowStream } from "#parquet/streams"

/**
 * The Overture-JP addresses the corpus reads.
 */
export function jpOvertureParquetPath() {
	return dataRootPath("overture", "2026-06-17.0", "addresses-jp.parquet")
}

/**
 * Japan Post's KEN_ALL_ROME file.
 */
export function kenAllPath() {
	return dataRootPath("KEN_ALL_ROME", "KEN_ALL_ROME.CSV")
}

/**
 * The WOF admin database the kana readings come from.
 */
export function jpAdminDBPath() {
	return dataRootPath("db", "wof", "admin-global-priority.db")
}

const KENALL_PAREN = /[（(].*?[）)]/gu
const KENALL_CATCH_ALL = "以下に掲載がない場合"
const AZA_PREFIX = /^(大字|字)/u
const POSTCODE_DIGITS = 7
const KENALL_COLUMNS = 6

/**
 * The tier a postcode lookup answered from.
 */
export type KenAllTier = "town" | "town_aza_stripped" | "municipality" | "miss"

/**
 * The 〒 join: the town first, the municipality's catch-all only as the fallback.
 *
 * KEN_ALL lists the town (大字 or 町) in column 4.
 * Overture writes the ōaza prefix (`字崎枝`, `大字上田`) that KEN_ALL omits, so a town miss is
 * retried with a leading 字 or 大字 stripped before the municipality catch-all.
 */
export class KenAllIndex {
	readonly town: ReadonlyMap<string, string>
	readonly municipality: ReadonlyMap<string, string>

	constructor(town: ReadonlyMap<string, string>, municipality: ReadonlyMap<string, string>) {
		this.town = town
		this.municipality = municipality
	}

	/**
	 * The postcode for a district and the tier that answered, or `null` with `miss`.
	 */
	lookup(prefecture: string, municipality: string, district: string): readonly [string | null, KenAllTier] {
		const head = normalizeCJKText(prefecture + municipality)

		if (district) {
			const hit = this.town.get(head + normalizeCJKText(district))

			if (hit) return [hit, "town"]

			const stripped = district.replace(AZA_PREFIX, "")

			if (stripped !== district) {
				const strippedHit = this.town.get(head + normalizeCJKText(stripped))

				if (strippedHit) return [strippedHit, "town_aza_stripped"]
			}
		}

		const hit = this.municipality.get(head)

		return hit ? [hit, "municipality"] : [null, "miss"]
	}
}

/**
 * KEN_ALL_ROME (cp932) read into the two-tier index.
 *
 * Columns are postcode, prefecture, city and town in kanji, then romaji.
 * A town's parenthetical annotation is stripped, and `以下に掲載がない場合` ("if not listed below")
 * is the municipality catch-all rather than a town.
 *
 * @throws When the file is missing, naming it.
 */
export async function loadKenAllPostcodes(path: PathBuilderLike): Promise<KenAllIndex> {
	if (!(await pathExists(path))) throw new Error(`No KEN_ALL file at ${path.toString()}`)

	const town = new Map<string, string>()
	const municipality = new Map<string, string>()

	for (const line of splitLines(decodeCP932(await readLocalBuffer(path)))) {
		const cells = line
			.replace(/[\r\n]+$/u, "")
			.split(",")
			.map((cell) => cell.replaceAll(/^"+|"+$/gu, ""))

		if (
			cells.length < KENALL_COLUMNS ||
			codePointLength(cells[0]!) !== POSTCODE_DIGITS ||
			!isDecimalDigits(cells[0]!)
		) {
			continue
		}

		const head = normalizeCJKText(cells[1]! + cells[2]!)

		if (!municipality.has(head)) {
			municipality.set(head, cells[0]!)
		}

		const name = cells[3]!.replace(KENALL_PAREN, "").trim()

		if (!name || name === KENALL_CATCH_ALL) continue

		const key = head + normalizeCJKText(name)

		if (!town.has(key)) {
			town.set(key, cells[0]!)
		}
	}

	return new KenAllIndex(town, municipality)
}

/**
 * One eligible source row: prefecture, municipality, street, number, longitude, latitude.
 */
export type JPSourceRow = readonly [
	prefecture: string,
	municipality: string,
	street: string,
	number: string,
	lon: number | null,
	lat: number | null,
]

interface OvertureRow {
	address_levels: Array<{ value: string | null }> | null
	street: string | null
	number: string | null
	lon: number | null
	lat: number | null
}

/**
 * Options for {@linkcode iterJPSourceRows}.
 */
export interface JPSourceRowOptions {
	maxRowGroups?: number
	/**
	 * @defaultValue {@linkcode MAX_FIELD_CHARS}
	 */
	maxFieldChars?: number
	/**
	 * Counts each dropped row by its reason.
	 */
	dropped?: Map<string, number>
}

/**
 * Every eligible source row, normalized.
 *
 * A row is eligible when both admin levels are present with the prefecture
 * among the 47, its street or number is non-empty, its number holds no comma
 * (an MLIT parcel aggregation such as `岡山町1154,1153,1155,…`), and its fields total at most
 * `maxFieldChars` code points, because the character path reads 96 units and would truncate it.
 *
 * @throws When the parquet file is missing, naming it.
 */
export async function* iterJPSourceRows(
	parquet: PathBuilderLike,
	options: JPSourceRowOptions = {}
): AsyncGenerator<JPSourceRow> {
	if (!(await pathExists(parquet))) throw new Error(`No Overture-JP parquet at ${parquet.toString()}`)

	const limit =
		typeof options.maxRowGroups === "number" ? await parquetRowGroupRows(parquet, options.maxRowGroups) : undefined

	const max = options.maxFieldChars ?? MAX_FIELD_CHARS

	const drop = (reason: string) => {
		if (options.dropped) {
			countInto(options.dropped, reason)
		}
	}

	for await (const row of openParquetRowStream<OvertureRow>(parquet, {
		columns: ["address_levels", "street", "number", "lon", "lat"],
		limit,
	})) {
		const level = row.address_levels

		if (!level || level.length < 2) {
			drop("levels")

			continue
		}

		const prefecture = level[0]!.value
		const municipality = level[1]!.value

		if (!prefecture || !municipality || !JP_PREFECTURE_NAMES.has(prefecture)) {
			drop("junk_prefecture")

			continue
		}

		if (!row.street && !row.number) {
			drop("empty")

			continue
		}

		if (row.number && row.number.includes(",")) {
			drop("parcel_list_number")

			continue
		}

		const street = row.street ? normalizeJPName(row.street) : ""
		const number = row.number ? normalizeJPNumber(row.number) : ""

		const total =
			codePointLength(prefecture) + codePointLength(municipality) + codePointLength(street) + codePointLength(number)

		if (total > max) {
			drop("too_long")

			continue
		}

		yield [prefecture, municipality, street, number, row.lon, row.lat]
	}
}
