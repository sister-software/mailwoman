/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file FCC BDC availability CSV byte-level parser.
 *
 *   Re-homed from Nexus's `sync/fcc/bdc/parsing.ts` (relicense-by-copy, no provenance headers): the same
 *   byte-scanning generator over the FCC's 12-column availability CSV — see the Nexus `RawBSLAvailabilityRow`
 *   tuple (`sync/fcc/bdc/block-aggregator.ts`) for the column order this scan assumes: frn, provider_id,
 *   brand_name, location_id, technology, max_advertised_download_speed, max_advertised_upload_speed,
 *   low_latency, business_residential_code, state_usps, block_geoid, h3_res8_id. Changed only where the
 *   pre-registered 2a decisions require: `geoid` (column 10, `block_geoid`) decodes to an ASCII string
 *   instead of staying a raw `Uint8Array` slice (decision 3), and `location_id` (column 3) stays a string
 *   instead of `parseInt`ing it, preserving leading zeros (decision 1). `business_residential_code` is
 *   likewise decoded to its ASCII string here — the Nexus original kept only the field's first raw byte as
 *   a bare `number`, which this port's `BDCAvailabilityRow` shape doesn't call for.
 *
 *   Columns 0-2 (frn, provider_id, brand_name) and 9, 11 (state_usps, h3_res8_id) are scanned over but
 *   never sliced into the output record: `provider_id` comes from the `providerID` parameter instead (the
 *   FCC partitions availability files per provider, so the caller already knows it), and FRN/brand/state/H3
 *   join concerns are out of scope for 2a (decision 8 — provider identity is a 2c registry-join seam).
 */

import type { ProviderID } from "./common.ts"

/**
 * Byte values this scanner switches on.
 *
 * Local to this file — no generic newline-delimited-file utility exists elsewhere in the repo to import. Nexus's
 * equivalent (`LineDelimitedCharacter`) lived in `@isp.nexus/sdk/files`, a workspace this port doesn't carry over, and
 * repo convention forbids TS `enum` anyway (`erasableSyntaxOnly`).
 */
const CSVByte = {
	Newline: 10,
	Comma: 44,
	DoubleQuote: 34,
	One: 49,
} as const

/**
 * A single parsed row of FCC BDC availability data.
 *
 * @see {@linkcode takeAvailabilityLine}
 */
export interface BDCAvailabilityRow {
	provider_id: number
	/**
	 * Kept as a string — the FCC's `location_id` values are zero-padded 10-digit strings; `parseInt`ing would lose
	 * leading zeros (2a decision 1).
	 */
	location_id: string
	technology_code: number
	max_advertised_download_speed: number
	max_advertised_upload_speed: number
	low_latency: 0 | 1
	business_residential_code: string
	/**
	 * Decoded to an ASCII string at the parse boundary (2a decision 3) — joins `TIGERBlockTable.GEOID` (note: uppercase
	 * column on that side).
	 */
	geoid: string
}

/**
 * Given a buffer containing FCC BDC availability CSV data, yield each data row (the header row is skipped) as a
 * {@linkcode BDCAvailabilityRow}.
 *
 * A byte-level scan, not a general CSV parser: it tracks comma/newline byte positions directly and only toggles
 * quote-awareness via a running double-quote count (an odd count means the scanner is currently inside a quoted field,
 * so a comma there isn't a column delimiter) — matching the Nexus original's approach for this specific, known-shaped
 * 12-column file rather than reaching for a general CSV library.
 */
export function* takeAvailabilityLine(csvBuffer: Buffer, providerID: ProviderID): Iterable<BDCAvailabilityRow> {
	// Skip the header row.
	let byteIndex = csvBuffer.indexOf(CSVByte.Newline) + 1
	const contentDelimiters = new Uint32Array(12) // 12 columns
	contentDelimiters[0] = byteIndex
	let delimiterIndex = 1
	let doubleQuoteCount = 0

	while (byteIndex < csvBuffer.length) {
		const byte = csvBuffer[byteIndex]

		if (byte === CSVByte.DoubleQuote) {
			doubleQuoteCount++
		}

		if (byte === CSVByte.Comma && doubleQuoteCount % 2 === 0) {
			contentDelimiters[delimiterIndex] = byteIndex

			delimiterIndex++
		}

		if (byte === CSVByte.Newline) {
			contentDelimiters[delimiterIndex] = CSVByte.Newline
			const slices: Buffer[] = []

			// Skip columns 0-2 (frn, provider_id, brand_name) — see the file header for why.
			for (let i = 3; i < contentDelimiters.length; i++) {
				const start = contentDelimiters[i]! + 1
				const end = contentDelimiters[i + 1]

				slices.push(csvBuffer.subarray(start, end))
			}

			const record: BDCAvailabilityRow = {
				provider_id: providerID,
				location_id: slices[0]!.toString("ascii"),
				technology_code: Number.parseInt(slices[1]!.toString(), 10),
				max_advertised_download_speed: Number.parseInt(slices[2]!.toString(), 10),
				max_advertised_upload_speed: Number.parseInt(slices[3]!.toString(), 10),
				low_latency: slices[4]![0] === CSVByte.One ? 1 : 0,
				business_residential_code: slices[5]!.toString("ascii"),
				geoid: slices[7]!.toString("ascii"),
			}

			yield record
			delimiterIndex = 1
			doubleQuoteCount = 0
		}

		byteIndex++
	}
}
