/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Stream unit-postcode records out of the extracted Code-Point Open area CSVs, converting OS's
 *   eastings/northings to WGS84 on the way through.
 *
 *   ## The row shape
 *
 *   Headerless, ten columns, every text field double-quoted. From `Doc/Code-Point_Open_Column_Headers.csv`:
 *
 *     PC, PQ, EA, NO, CY, RH, LH, CC, DC, WC
 *     Postcode, Positional_quality_indicator, Eastings, Northings, Country_code,
 *     NHS_regional_HA_code, NHS_HA_code, Admin_county_code, Admin_district_code, Admin_ward_code
 *
 *   We read the first five and drop the health/admin codes — they are ONS lookup keys, not geography,
 *   and nothing in the resolver consumes them.
 *
 *   ## Two traps, both measured against the 2026-05 cut
 *
 *   1. **865 rows carry no coordinate.** Positional quality indicator `90` means "no coordinate
 *      available", and those rows are written as eastings `0`, northings `0`. Grid `0,0` is a REAL
 *      place — open Atlantic south-west of the Scillies — so nothing downstream can recognise it as a
 *      sentinel after conversion. They are dropped HERE, at the only layer that still has the PQI to
 *      drop them by. Distribution across all 1,747,841 rows: PQI 10 → 1,742,328 · 20 → 253 · 30 → 26 ·
 *      50 → 4,166 · 60 → 203 · 90 → 865. So 99.69 % of the file is PQI 10, OS's best grade (within the
 *      building of the address nearest the postcode's mean position).
 *   2. **Quoting applies to record boundaries as well as columns.** The current cut carries no embedded
 *      comma or newline, but both are legal inside a quoted CSV field. Parsing the byte stream with quote
 *      handling enabled keeps such a field intact even when its newline or closing quote crosses a read
 *      boundary; a line-first parser cannot repair the record after splitting it.
 */

import { osgb36ToWGS84 } from "@mailwoman/spatial"
import { CSVSpliterator } from "spliterator"

import { normalizePostcodeDisplay } from "#gazetteer-pipeline/postcode/display-form"

/**
 * Positional quality indicator meaning "no coordinate available". Such rows carry eastings/northings of zero.
 */
export const PQI_NO_COORDINATE = 90

/**
 * Number of columns in a Code-Point Open CSV row.
 */
const CODEPOINT_COLUMNS = 10

/**
 * ONS country codes present in Code-Point Open, and the ISO-3166-2 subdivision each maps to. There are exactly three —
 * the absence of a Northern Ireland code is the product's defining coverage limit, not an omission here.
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
	 * The postcode in OS's own spacing — outward code, one space, inward code (`SW1A 1AA`). This is the DISPLAY form; the
	 * normalized lookup form is derived by the shard builder via the #920 name law.
	 */
	postcode: string
	/**
	 * Positional quality indicator: 10 (best) … 60. Never 90 — those rows are dropped.
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
	 * WGS84 latitude, converted from the grid reference. Accurate to ~2 m (see `@mailwoman/spatial`'s `osgb36.ts`).
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
 * What a parse run skipped, and why. Kept as counters rather than a boolean so the builder's provenance can state the
 * meaning of each zero — "measured, none" is a different claim from "never looked".
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
	 * Per-postcode-area yielded counts, keyed by uppercase outward area (`AB`, `B`, `ZE`) — the figures compared against
	 * the archive's own `Doc/metadata.txt` manifest.
	 */
	yieldedByArea: Record<string, number>
}

/**
 * A GB unit postcode: 1-2 letters, then the rest of the outward code, a space, then digit + two letters. Deliberately
 * loose about the outward code's shape (`W1A`, `EC1A`, `B1`, `DN55` are all legal and differ structurally) and strict
 * about the inward code, which is invariant.
 */
const UNIT_POSTCODE = /^[A-Z]{1,2}[0-9][A-Z0-9]?\s[0-9][A-Z]{2}$/

/**
 * Extract the postcode AREA — the leading one or two letters (`SW1A 1AA` → `SW`, `B33 8TH` → `B`). This is the key
 * `Doc/metadata.txt` counts by.
 */
export function postcodeArea(postcode: string): string {
	return /^[A-Z]{1,2}/.exec(postcode)?.[0] ?? ""
}

/**
 * Split one CSV line into fields, honouring RFC-4180 double quoting: quotes wrap a field, a doubled `""` inside a
 * quoted field is a literal quote, and a comma inside quotes is data rather than a separator.
 *
 * Retained as a compatibility helper for callers parsing one resident record. Streaming callers should use
 * {@linkcode readCodePointCSV}, which preserves quoted newlines across read boundaries.
 *
 * @deprecated Use `CSVSpliterator` directly.
 */
export function splitCSVLine(line: string): string[] {
	return (
		CSVSpliterator.from<string[]>(line, {
			header: false,
			enableQuoteHandling: true,
		}).next().value ?? []
	)
}

/**
 * Stream every usable record from one extracted area CSV, mutating `stats` as it goes.
 *
 * Yields rather than collecting: the whole of GB is 1.75 M rows, and the shard builder inserts as it reads rather than
 * materializing an array it would only iterate once.
 */
export async function* readCodePointCSV(csvPath: string, stats: CodePointParseStats): AsyncGenerator<CodePointRecord> {
	// These files have no header row; the column names ship separately in
	// `Doc/Code-Point_Open_Column_Headers.csv`.
	for await (const row of CSVSpliterator.fromAsync<string[]>(csvPath, {
		header: false,
		enableQuoteHandling: true,
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
 * The product is SPECIFIED as a fixed 7-character field — the outward code left-justified, the inward code
 * right-justified, so a short postcode like `B1 1AA` is padded to `B1 1AA` with two spaces. The 2026-05 CSVs happen to
 * ship the single-spaced form already, but the specification is what a future cut will follow, and a double space would
 * otherwise sail through as a distinct postcode from its single-spaced twin. Collapsing runs of whitespace costs one
 * regex and closes that.
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
