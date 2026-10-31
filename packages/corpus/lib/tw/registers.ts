/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The GCIS company and business registers as a noisy corpus source: the addresses a clerk typed, aligned
 *   against the Overture-TW key sets and kept only where the whole key matches.
 *
 *   Ported from the Python builders' `countries/tw/registers.py`. Offsets are code points.
 */

import { sortedGlob } from "@mailwoman/core/fs/readers"
import { isDirectory } from "@mailwoman/core/fs/readers/stat"
import { codePointLength } from "@mailwoman/core/strings/code-points"
import { splitWhitespace } from "@mailwoman/core/strings/unicode"
import type { PathBuilderLike } from "path-ts"
import { CSVSpliterator } from "spliterator"

import { addToKeySet, type CJKRecord, unitKey } from "#cjk/builder"
import { asciiDigits, normalizeCJKText } from "#cjk/text"
import { parquetRowGroupRows } from "#parquet/readers"
import { openParquetRowStream } from "#parquet/streams"

/**
 * The corpus source of the register's rows.
 */
export const TW_REGISTRY_SOURCE = "gcis-tw"

const COUNTRY = "TW"

/**
 * The hold-out bucket from which a Taiwanese (縣市, 鄉鎮市區) unit is a board unit: buckets 90 to 99 of 100.
 */
export const TW_BOARD_BUCKET_MIN = 90

const DIGITS = "0-9０-９"
const SUB = `(?:之|[-－─‐−])[${DIGITS}]+`
const NUMBER = new RegExp(`^(?<number>[${DIGITS}]+(?:${SUB})*(?:附[${DIGITS}]+)?號(?:${SUB})?)(?<rest>.*)$`, "u")

const FLOOR = new RegExp(
	`^[（(]?(?:(?:地下|B|Ｂ)?[${DIGITS}一二三四五六七八九十]+(?:樓|層|F|Ｆ)(?:之[${DIGITS}]+)?|地下室|頂樓)[）)]?$`,
	"u"
)

const SECTION = new RegExp(`([${DIGITS}]+)段`, "gu")
const KANJI_SECTION = "〇一二三四五六七八九十"

/**
 * The admin levels required in an Overture-TW row are 縣市, 鄉鎮市區 and 村里.
 */
export const TW_ADMIN_LEVELS = 3

/**
 * A register or Overture value folded to its key: whitespace-free NFC, ASCII digits,
 * 台 as 臺, and a section number up to 十 in kanji.
 */
export function twFoldKey(text: string): string {
	const folded = asciiDigits(normalizeCJKText(text.normalize("NFC"))).replaceAll("台", "臺")

	return folded.replace(SECTION, (_whole, digits: string) => {
		const value = Number(asciiDigits(digits))

		return (KANJI_SECTION[value] ?? digits) + "段"
	})
}

/**
 * The Overture-TW key sets: regions, each region's districts, and each unit's villages and streets.
 */
export class TWKeyIndex {
	readonly regions = new Set<string>()
	readonly districtsByRegion = new Map<string, Set<string>>()
	readonly villagesByUnit = new Map<string, Set<string>>()
	readonly streetsByUnit = new Map<string, Set<string>>()

	/**
	 * Builds the index from an Overture-TW parquet file, or from its first `maxRowGroups` row groups.
	 *
	 * @throws When the file is missing.
	 */
	static async fromParquet(parquet: PathBuilderLike, maxRowGroups?: number): Promise<TWKeyIndex> {
		const limit = typeof maxRowGroups === "number" ? await parquetRowGroupRows(parquet, maxRowGroups) : undefined
		const index = new TWKeyIndex()

		interface Row {
			address_levels: Array<{ value: string | null }> | null
			street: string | null
		}

		for await (const row of openParquetRowStream<Row>(parquet, { columns: ["address_levels", "street"], limit })) {
			const level = row.address_levels

			if (!level || level.length < TW_ADMIN_LEVELS || !row.street) continue

			const [region, district, village] = level.slice(0, TW_ADMIN_LEVELS).map((entry) => twFoldKey(entry.value || ""))

			if (!region || !district) continue

			index.regions.add(region)
			addToKeySet(index.districtsByRegion, region, district)

			const unit = unitKey(region, district)

			if (village) {
				addToKeySet(index.villagesByUnit, unit, village)
			}

			addToKeySet(index.streetsByUnit, unit, twFoldKey(row.street))
		}

		return index
	}
}

/**
 * One register row's name and its two address forms.
 */
export interface TWRegisterRow {
	name: string
	address: string
	taxAddress: string
}

/**
 * Every register row with an address, from each CSV in `sourceDirectory` in code-point order of their paths.
 *
 * @throws When the directory is missing or holds no CSV, naming it.
 */
export async function* iterTWRegisterRows(sourceDirectory: PathBuilderLike): AsyncGenerator<TWRegisterRow> {
	if (!(await isDirectory(sourceDirectory))) {
		throw new Error(`No GCIS register directory at ${sourceDirectory.toString()}`)
	}

	const paths = await sortedGlob(sourceDirectory, "*.csv")

	if (!paths.length) throw new Error(`No GCIS register CSV in ${sourceDirectory.toString()}`)

	for (const path of paths) {
		for await (const row of CSVSpliterator.fromAsync<Record<string, string | undefined>>(path)) {
			const address = row["公司地址"] || row["商業地址"] || row["地址"] || ""
			const taxAddress = row["營業地址（財政資訊中心匯入）"] || ""
			const name = row["公司名稱"] || row["商業名稱"] || ""

			if (address || taxAddress) {
				yield { name: String(name), address: String(address), taxAddress: String(taxAddress) }
			}
		}
	}
}

/**
 * A register address rendered whitespace-free and spanned.
 */
export interface TWAligned {
	raw: string
	span_starts: number[]
	span_ends: number[]
	span_tags: string[]
	register: string
	region: string
	district: string
}

const MAX_KEY_WIDTH = 12

/**
 * The longest piece of 2 to 12 code points at `at` whose folded key is in `candidates`.
 */
function longestPrefix(characters: readonly string[], at: number, candidates: ReadonlySet<string> | undefined) {
	let best: string | null = null

	if (!candidates) return best

	for (let width = 2; width <= Math.min(MAX_KEY_WIDTH, characters.length - at); width++) {
		const piece = characters.slice(at, at + width).join("")

		if (candidates.has(twFoldKey(piece)) && (best === null || codePointLength(piece) > codePointLength(best))) {
			best = piece
		}
	}

	return best
}

/**
 * A register address aligned to region, district, village, street, number and floor,
 * or `null` when any required part does not match the key sets.
 */
export function alignRegisterAddress(text: string, index: TWKeyIndex): TWAligned | null {
	const raw = splitWhitespace(text).join("")

	if (!raw) return null

	const characters = [...raw]
	const spans: Array<readonly [number, number, string]> = []
	let at = 0

	const take = (piece: string, tag: string) => {
		const width = codePointLength(piece)

		spans.push([at, at + width, tag])
		at += width
	}

	const region = longestPrefix(characters, at, index.regions)

	if (!region) return null

	take(region, "region")

	const regionKey = twFoldKey(region)
	const district = longestPrefix(characters, at, index.districtsByRegion.get(regionKey))

	if (!district) return null

	take(district, "subregion")

	const unit = unitKey(regionKey, twFoldKey(district))
	const village = longestPrefix(characters, at, index.villagesByUnit.get(unit))

	if (village) {
		take(village, "dependent_locality")
	}

	const street = longestPrefix(characters, at, index.streetsByUnit.get(unit))

	if (!street) return null

	take(street, "street")

	const match = NUMBER.exec(characters.slice(at).join(""))

	if (!match) return null

	take(match.groups!["number"]!, "house_number")

	const rest = match.groups!["rest"]!

	if (rest) {
		if (!FLOOR.test(rest)) return null

		take(rest, "unit")
	}

	return {
		raw,
		span_starts: spans.map(([start]) => start),
		span_ends: spans.map(([, end]) => end),
		span_tags: spans.map((span) => span[2]),
		register: "registry",
		region: regionKey,
		district: twFoldKey(district),
	}
}

/**
 * An aligned row as a corpus record, its whole raw string one token.
 */
export function twRegistryRecord(aligned: TWAligned): CJKRecord {
	return {
		raw: aligned.raw,
		tokens: [aligned.raw],
		labels: [`B-${aligned.span_tags[0]}`],
		span_starts: [...aligned.span_starts],
		span_ends: [...aligned.span_ends],
		span_tags: [...aligned.span_tags],
		country: COUNTRY,
		source: TW_REGISTRY_SOURCE,
		register: aligned.register,
	}
}
