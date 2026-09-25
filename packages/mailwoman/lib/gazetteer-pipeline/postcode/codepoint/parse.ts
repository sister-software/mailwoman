/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Streams unit-postcode rows from extracted Code-Point Open CSVs and converts their OSGB36
 *   coordinates to WGS84.
 */

import { osgb36ToWGS84 } from "@mailwoman/spatial"
import { CSVSpliterator } from "spliterator"

import { normalizePostcodeDisplay } from "#gazetteer-pipeline/postcode/display-form"

/**
 * The positional quality indicator for a row with no coordinate.
 *
 * These rows carry zero eastings and northings, which would convert to a real but wrong location.
 */
export const PQI_NO_COORDINATE = 90

/**
 * The number of columns in a Code-Point Open CSV row.
 */
const CODEPOINT_COLUMNS = 10

/**
 * The ONS country codes in Code-Point Open, mapped to ISO 3166-2 subdivisions.
 *
 * Northern Ireland has no code because the product does not cover it.
 */
export const CODEPOINT_COUNTRY_CODES = {
	E92000001: "ENG",
	S92000003: "SCT",
	W92000004: "WLS",
} as const

/**
 * One subdivision code from {@link CODEPOINT_COUNTRY_CODES}.
 */
export type CodePointCountry = (typeof CODEPOINT_COUNTRY_CODES)[keyof typeof CODEPOINT_COUNTRY_CODES]

/**
 * One unit postcode with a usable coordinate.
 */
export interface CodePointRecord {
	/**
	 * The display form of the postcode, with one space between outward and inward codes, such as `SW1A 1AA`.
	 * The database builder derives the lookup form.
	 */
	postcode: string
	/**
	 * The positional quality indicator, from 10 (best) to 60.
	 * Rows with 90 are dropped.
	 */
	quality: number
	/**
	 * The OSGB36 easting in metres, as published.
	 */
	easting: number
	/**
	 * The OSGB36 northing in metres, as published.
	 */
	northing: number
	/**
	 * The WGS84 latitude converted from the grid reference, accurate to about 2 m.
	 */
	latitude: number
	/**
	 * The WGS84 longitude.
	 */
	longitude: number
	/**
	 * The ONS country code as published.
	 */
	countryCode: string
	/**
	 * The subdivision for the country code, or null for an unknown code.
	 */
	country: CodePointCountry | null
}

/**
 * Counts from a parse run, including the reason for each skipped row.
 */
export interface CodePointParseStats {
	/**
	 * Rows read, including skipped rows.
	 */
	read: number
	/**
	 * Rows yielded.
	 */
	yielded: number
	/**
	 * Rows dropped for positional quality 90.
	 */
	skippedNoCoordinate: number
	/**
	 * Rows dropped for a malformed postcode, a non-numeric grid reference, or the wrong column count.
	 */
	skippedMalformed: number
	/**
	 * Yielded rows per postcode area, such as `AB` or `B`.
	 *
	 * These counts can be compared with the archive's `Doc/metadata.txt`.
	 */
	yieldedByArea: Record<string, number>
}

/**
 * Matches a GB unit postcode with a single space.
 *
 * The pattern accepts any valid outward-code shape, such as `W1A`, `EC1A`, `B1`, or `DN55`.
 * The inward code is always a digit followed by two letters.
 */
const UNIT_POSTCODE = /^[A-Z]{1,2}[0-9][A-Z0-9]?\s[0-9][A-Z]{2}$/

/**
 * Returns the postcode area, which is the leading one or two letters.
 *
 * For example, `SW1A 1AA` gives `SW` and `B33 8TH` gives `B`.
 * `Doc/metadata.txt` counts rows by area.
 */
export function postcodeArea(postcode: string): string {
	return /^[A-Z]{1,2}/.exec(postcode)?.[0] ?? ""
}

/**
 * Splits one CSV record into fields with RFC 4180 quoting.
 *
 * @deprecated Use `CSVSpliterator` directly.
 * Streaming callers should use {@linkcode readCodePointCSV}.
 */
export function splitCSVLine(line: string): string[] {
	return CSVSpliterator.from<string[]>(line, { header: false }).next().value ?? []
}

/**
 * Streams every usable record from one extracted area CSV and updates `stats` as it reads.
 */
export async function* readCodePointCSV(csvPath: string, stats: CodePointParseStats): AsyncGenerator<CodePointRecord> {
	// The CSVs have no header row.
	// OS ships the column names in `Doc/Code-Point_Open_Column_Headers.csv`.
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
 * Normalizes Code-Point postcode spacing to the single-space display form.
 *
 * The product specification uses a fixed seven-character field that pads short postcodes with extra spaces.
 * Normalizing keeps a padded postcode from becoming a separate entry.
 */
export function normalizeCodePointSpacing(raw: string): string {
	return normalizePostcodeDisplay(raw)
}

/**
 * Returns a stats object with every count at zero.
 */
export function createCodePointParseStats(): CodePointParseStats {
	return { read: 0, yielded: 0, skippedNoCoordinate: 0, skippedMalformed: 0, yieldedByArea: {} }
}
