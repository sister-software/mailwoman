/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Stream unit-postcode rows from extracted Code-Point Open CSVs and convert OSGB36 coordinates
 *   to WGS84. Files are headerless; only postcode, quality, grid coordinates, and country are used.
 *   Drop quality-90 rows before conversion because their zero grid coordinates are not a sentinel.
 *   Use a streaming quote-aware CSV parser to preserve fields across record boundaries.
 */

import { osgb36ToWGS84 } from "@mailwoman/spatial"
import { CSVSpliterator } from "spliterator"

import { normalizePostcodeDisplay } from "#gazetteer-pipeline/postcode/display-form"

/**
 * Positional quality indicator meaning "no coordinate available".
 *
 * Such rows carry eastings/northings of zero.
 */
export const PQI_NO_COORDINATE = 90

/**
 * Number of columns in a Code-Point Open CSV row.
 */
const CODEPOINT_COLUMNS = 10

/**
 * ONS country codes present in Code-Point Open, and the ISO-3166-2 subdivision each maps to.
 *
 * There are exactly three.
 * The absence of a Northern Ireland code is the product's defining coverage limit
 * rather than an omission here.
 */
export const CODEPOINT_COUNTRY_CODES = {
	E92000001: "ENG",
	S92000003: "SCT",
	W92000004: "WLS",
} as const

export type CodePointCountry = (typeof CODEPOINT_COUNTRY_CODES)[keyof typeof CODEPOINT_COUNTRY_CODES]

/**
 * One unit postcode with a usable coordinate.
 */
export interface CodePointRecord {
	/**
	 * The postcode in OS's own spacing — outward code, one space, inward code (`SW1A 1AA`).
	 *
	 * This is the display form.
	 * The normalized lookup form is derived by the database builder via the #920 name law.
	 */
	postcode: string
	/**
	 * Positional quality indicator: 10 (best) … 60.
	 *
	 * Never 90 — those rows are dropped.
	 */
	quality: number
	/**
	 * OSGB36 easting in metres, as published.
	 */
	easting: number
	/**
	 * OSGB36 northing in metres, as published.
	 */
	northing: number
	/**
	 * WGS84 latitude, converted from the grid reference.
	 *
	 * Accurate to ~2 m (see `@mailwoman/spatial`'s `osgb36.ts`).
	 */
	latitude: number
	/**
	 * WGS84 longitude.
	 */
	longitude: number
	/**
	 * ONS country code, verbatim (`E92000001` / `S92000003` / `W92000004`).
	 */
	countryCode: string
	/**
	 * The subdivision the country code maps to, or null if OS ever emits one we don't know.
	 */
	country: CodePointCountry | null
}

/**
 * What a parse run skipped, and why.
 *
 * Kept as counters rather than a boolean so the builder's provenance can state the meaning
 * of each zero — "measured, none" is a different claim from "never looked".
 */
export interface CodePointParseStats {
	/**
	 * Rows read from the CSVs, including every skipped one.
	 */
	read: number
	/**
	 * Rows yielded.
	 */
	yielded: number
	/**
	 * Rows dropped for positional quality 90 (no coordinate available).
	 */
	skippedNoCoordinate: number
	/**
	 * Rows dropped for a malformed postcode, a non-numeric grid reference, or the wrong column count.
	 */
	skippedMalformed: number
	/**
	 * Per-postcode-area yielded counts, keyed by uppercase outward area (`AB`, `B`, `ZE`) —
	 * the figures compared against the archive's own `Doc/metadata.txt` manifest.
	 */
	yieldedByArea: Record<string, number>
}

/**
 * A GB unit postcode: 1-2 letters, then the rest of the outward code, a space, then digit + two letters.
 *
 * Deliberately loose about the outward code's shape (`W1A`, `EC1A`, `B1`, `DN55` are all legal
 * and differ structurally) and strict about the inward code, which is invariant.
 */
const UNIT_POSTCODE = /^[A-Z]{1,2}[0-9][A-Z0-9]?\s[0-9][A-Z]{2}$/

/**
 * Extract the postcode area — the leading one or two letters (`SW1A 1AA` → `SW`, `B33 8TH` → `B`).
 *
 * This is the key `Doc/metadata.txt` counts by.
 */
export function postcodeArea(postcode: string): string {
	return /^[A-Z]{1,2}/.exec(postcode)?.[0] ?? ""
}

/**
 * Split one CSV line into fields, honouring RFC-4180 double quoting:
 * quotes wrap a field, a doubled `""` inside a quoted field is a literal quote,
 * and a comma inside quotes is data rather than a separator.
 *
 * Retained as a compatibility helper for callers parsing one resident record.
 * Streaming callers should use {@linkcode readCodePointCSV}, which preserves
 * quoted newlines across read boundaries.
 *
 * @deprecated Use `CSVSpliterator` directly.
 */
export function splitCSVLine(line: string): string[] {
	return CSVSpliterator.from<string[]>(line, { header: false }).next().value ?? []
}

/**
 * Stream every usable record from one extracted area CSV, mutating `stats` as it goes.
 *
 * Yields rather than collecting: the whole of GB is 1.75 M rows, and the database builder
 * inserts as it reads rather than materializing an array it would only iterate once.
 */
export async function* readCodePointCSV(csvPath: string, stats: CodePointParseStats): AsyncGenerator<CodePointRecord> {
	// These files have no header row.
	// The column names ship separately in `Doc/Code-Point_Open_Column_Headers.csv`.
	for await (const row of CSVSpliterator.fromAsync<string[]>(csvPath, {
		header: false,
	})) {
		stats.read++

		if (row.length !== CODEPOINT_COLUMNS) {
			stats.skippedMalformed++

			continue
		}

		const postcode = normalizeCodePointSpacing(row[0] ?? "")
		const quality = Number(row[1])
		const easting = Number(row[2])
		const northing = Number(row[3])
		const countryCode = (row[4] ?? "").trim()

		if (quality === PQI_NO_COORDINATE) {
			stats.skippedNoCoordinate++

			continue
		}

		if (!UNIT_POSTCODE.test(postcode) || !Number.isFinite(easting) || !Number.isFinite(northing)) {
			stats.skippedMalformed++

			continue
		}

		const { latitude, longitude } = osgb36ToWGS84({ easting, northing })
		const area = postcodeArea(postcode)

		stats.yielded++
		stats.yieldedByArea[area] = (stats.yieldedByArea[area] ?? 0) + 1

		yield {
			postcode,
			quality,
			easting,
			northing,
			latitude,
			longitude,
			countryCode,
			country: CODEPOINT_COUNTRY_CODES[countryCode as keyof typeof CODEPOINT_COUNTRY_CODES] ?? null,
		}
	}
}

/**
 * Normalize Code-Point's postcode spacing to the single-space display form.
 *
 * The product is specified as a fixed 7-character field.
 * The outward code left-justified, the inward code right-justified, so a short
 * postcode like `B1 1AA` is padded to `B1 1AA` with two spaces.
 *
 * The 2026-05 CSVs happen to ship the single-spaced form already, but the specification
 * is what a future extract will follow, and a double space would otherwise sail
 * through as a distinct postcode from its single-spaced twin.
 *
 * Collapsing runs of whitespace costs one regex and closes that.
 */
export function normalizeCodePointSpacing(raw: string): string {
	return normalizePostcodeDisplay(raw)
}

/**
 * A zeroed stats accumulator.
 */
export function createCodePointParseStats(): CodePointParseStats {
	return { read: 0, yielded: 0, skippedNoCoordinate: 0, skippedMalformed: 0, yieldedByArea: {} }
}
