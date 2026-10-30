/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reads the Overture-TW parquet and renders one Taiwanese row in one register.
 *
 *   Labels sit under the `stage3-cjk` head, one tag per WOF placetype: 縣市 `region`, 鄉鎮市區 `subregion`, 村里
 *   `dependent_locality`, the street with its section, lane and alley `street`, the number with its 之N sub-number
 *   and 號 `house_number`, and the floor `unit`.
 *
 *   Ported from the Python builders' `countries/tw/corpora/rows.py`.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { countInto } from "@mailwoman/core/stats"
import type { PathBuilderLike } from "path-ts"

import {
	type CJKRecord,
	codePointLength,
	labelTokensByFirstSpan,
	MAX_FIELD_CHARS,
	RowRenderer,
	verifyRecord,
} from "#cjk/builder"
import { asciiDigits, fullwidthDigits, normalizeCJKText } from "#cjk/text"
import { parquetRowGroupRows } from "#parquet/readers"
import { openParquetRowStream } from "#parquet/streams"
import type { PyRandom } from "#training/pyrandom"
import { TW_ADMIN_LEVELS } from "#tw/registers"

/**
 * The Overture-TW addresses the corpus reads.
 */
export function twOvertureParquetPath() {
	return dataRootPath("overture", "2026-06-17.0", "addresses-tw.parquet")
}

/**
 * The label set Taiwanese rows are tagged against.
 */
export const TW_LABEL_SET_NAME = "stage3-cjk"

/**
 * The corpus source of the rows.
 */
export const TW_CORPUS_SOURCE = "overture-tw"

const COUNTRY = "TW"
const COUNTRY_NAME = "台灣"

/**
 * Each register's weight.
 *
 * The sampler renormalizes them over the registers a row can render.
 */
export const TW_REGISTER_WEIGHTS = new Map<string, number>([
	["official", 0.25],
	["no_village", 0.35],
	["spaced", 0.15],
	["no_region", 0.1],
	["with_unit", 0.15],
])

const SUB_NUMBER = /^(之[0-9０-９]+(?:附[0-9０-９]+)?號?)(.*)$/u

/**
 * One eligible source row: region, district, village, street, house number
 * (with its sub-number), unit, longitude, latitude.
 */
export type TWSourceRow = readonly [
	region: string,
	district: string,
	village: string,
	street: string,
	houseNumber: string,
	unit: string,
	lon: number,
	lat: number,
]

/**
 * The sub-number at the head of `unit` moved onto `number`, unless `number` already
 * closes with 號 and the unit continues past it.
 */
export function splitNumberUnit(number: string, unit: string): readonly [number: string, unit: string] {
	const match = SUB_NUMBER.exec(unit)

	if (!match) return [number, unit]

	const [, sub, rest] = match

	if (number.endsWith("號")) return rest ? [number, unit] : [number + sub!, ""]

	return [number + sub!, rest!]
}

/**
 * The fields of one row and the draws that decide its surface.
 */
export interface TWRenderInput {
	region: string
	district: string
	village: string
	street: string
	houseNumber: string
	unit: string
	register: string
	country?: boolean
}

/**
 * One row rendered in one register as a span-labeled corpus record.
 *
 * The official register writes full-width digits and the 村里.
 * Every other register writes ASCII digits.
 */
export function renderTWRow(input: TWRenderInput): CJKRecord {
	const renderer = new RowRenderer()
	const separator = input.register === "spaced" ? " " : ""
	const digits = input.register === "official" ? fullwidthDigits : asciiDigits

	if (input.country) {
		renderer.put("country", COUNTRY_NAME)
		renderer.glue(separator)
	}

	if (input.register !== "no_region") {
		renderer.put("region", input.region)
		renderer.glue(separator)
	}

	renderer.put("subregion", input.district)
	renderer.glue(separator)

	if (input.register === "official" && input.village) {
		renderer.put("dependent_locality", input.village)
		renderer.glue(separator)
	}

	renderer.put("street", digits(input.street))
	renderer.glue(separator)
	renderer.put("house_number", digits(input.houseNumber))

	if (input.register === "with_unit" && input.unit) {
		renderer.glue(separator)
		renderer.put("unit", digits(input.unit))
	}

	return {
		raw: renderer.raw,
		...labelTokensByFirstSpan(renderer.raw, renderer.starts, renderer.ends, renderer.tags),
		span_starts: renderer.starts,
		span_ends: renderer.ends,
		span_tags: renderer.tags,
		country: COUNTRY,
		source: TW_CORPUS_SOURCE,
		register: input.register,
	}
}

/**
 * The registers a row can render: `official` only with a 村里, `with_unit` only with a unit.
 */
export function availableTWRegisters(village: string, unit: string): string[] {
	return [...TW_REGISTER_WEIGHTS.keys()].filter(
		(name) => (name !== "official" || village) && (name !== "with_unit" || unit)
	)
}

/**
 * One of `options`, drawn by {@linkcode TW_REGISTER_WEIGHTS}.
 * A single option is returned without a draw.
 */
export function chooseTWRegister(rng: PyRandom, options: readonly string[]): string {
	if (options.length === 1) return options[0]!

	return rng.choices(options, { weights: options.map((name) => TW_REGISTER_WEIGHTS.get(name)!) })[0]!
}

/**
 * {@linkcode verifyRecord} under {@linkcode TW_LABEL_SET_NAME}.
 */
export function verifyTWRecord(record: CJKRecord, tagSet: ReadonlySet<string>): void {
	verifyRecord(record, tagSet, { labelSetName: TW_LABEL_SET_NAME })
}

interface OvertureRow {
	address_levels: Array<{ value: string | null }> | null
	street: string | null
	number: string | null
	unit: string | null
	lon: number
	lat: number
	sources: Array<{ dataset: string | null }> | null
}

/**
 * Options for {@linkcode iterTWSourceRows}.
 */
export interface TWSourceRowOptions {
	maxRowGroups?: number
	/**
	 * @defaultValue {@linkcode MAX_FIELD_CHARS}
	 */
	maxFieldChars?: number
	dropped?: Map<string, number>
	/**
	 * Counts each row's source datasets, which the build report lists for attribution.
	 */
	agencies?: Map<string, number>
}

/**
 * Every eligible source row, normalized: three admin levels with the first two present,
 * a street and a number, and no field longer than `maxFieldChars` code points.
 *
 * @throws When the parquet file is missing, naming it.
 */
export async function* iterTWSourceRows(
	parquet: PathBuilderLike,
	options: TWSourceRowOptions = {}
): AsyncGenerator<TWSourceRow> {
	if (!(await pathExists(parquet))) throw new Error(`No Overture-TW parquet at ${parquet.toString()}`)

	const limit =
		typeof options.maxRowGroups === "number" ? await parquetRowGroupRows(parquet, options.maxRowGroups) : undefined

	const max = options.maxFieldChars ?? MAX_FIELD_CHARS

	const drop = (reason: string) => {
		if (options.dropped) {
			countInto(options.dropped, reason)
		}
	}

	for await (const row of openParquetRowStream<OvertureRow>(parquet, {
		columns: ["address_levels", "street", "number", "unit", "lon", "lat", "sources"],
		limit,
	})) {
		const levels = (row.address_levels ?? []).map((entry) => entry.value || "")

		if (levels.length < TW_ADMIN_LEVELS || !levels[0] || !levels[1]) {
			drop("levels")

			continue
		}

		const street = normalizeCJKText(row.street || "")
		const number = normalizeCJKText(row.number || "")
		const unit = normalizeCJKText(row.unit || "")

		if (!street || !number) {
			drop("empty")

			continue
		}

		const region = normalizeCJKText(levels[0])
		const district = normalizeCJKText(levels[1])
		const village = normalizeCJKText(levels[2]!)
		const [houseNumber, floor] = splitNumberUnit(number, unit)

		if ([region, district, village, street, houseNumber, floor].some((value) => codePointLength(value) > max)) {
			drop("field_too_long")

			continue
		}

		if (options.agencies) {
			for (const source of row.sources ?? []) {
				if (source.dataset) {
					countInto(options.agencies, source.dataset)
				}
			}
		}

		yield [
			region,
			district,
			village,
			street,
			houseNumber,
			floor,
			coordinate(row.lon, "lon"),
			coordinate(row.lat, "lat"),
		]
	}

	/**
	 * A row's coordinate as a finite number.
	 *
	 * `Number(null)` is `0`, which would place the row at the origin and pull its district's centroid there.
	 * Python's `float(None)` raised, so a missing coordinate raises here as well,
	 * naming the file and the field.
	 */
	function coordinate(value: unknown, field: "lon" | "lat"): number {
		const parsed =
			typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN

		if (!Number.isFinite(parsed)) {
			throw new TypeError(`${parquet.toString()}: a row's ${field} is ${String(value)}, not a finite number`)
		}

		return parsed
	}
}
