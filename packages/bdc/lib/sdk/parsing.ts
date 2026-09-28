/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file FCC BDC availability CSV row reader.
 */

import type { AsyncDataResource } from "spliterator"
import { CSVSpliterator } from "spliterator"

import type { ProviderID } from "#sdk/common"

/**
 * Column positions in the FCC's 12-column availability CSV, kept in header order
 * so a reader can check them against the header row.
 */
const Column = {
	LocationID: 3,
	Technology: 4,
	MaxAdvertisedDownloadSpeed: 5,
	MaxAdvertisedUploadSpeed: 6,
	LowLatency: 7,
	BusinessResidentialCode: 8,
	BlockGeoID: 10,
} as const

/**
 * A single parsed row of FCC BDC availability data.
 *
 * @see {@linkcode readAvailabilityRows}
 */
export interface BDCAvailabilityRow {
	provider_id: number
	/**
	 * Kept as a string, since the FCC's `location_id` values are zero-padded 10-digit
	 * strings whose leading zeros `parseInt` would lose.
	 */
	location_id: string
	technology_code: number
	max_advertised_download_speed: number
	max_advertised_upload_speed: number
	low_latency: 0 | 1
	business_residential_code: string
	/**
	 * Joins `TIGERBlockTable.geoid`, which is uppercase on that side.
	 */
	geoid: string
}

/**
 * Project one already-split CSV row onto {@linkcode BDCAvailabilityRow}, shared
 * so the sync and async readers cannot drift in what they emit.
 */
function projectRow(columns: readonly string[], providerID: ProviderID): BDCAvailabilityRow {
	return {
		provider_id: providerID,
		location_id: columns[Column.LocationID] ?? "",
		technology_code: Number.parseInt(columns[Column.Technology] ?? "", 10),
		max_advertised_download_speed: Number.parseInt(columns[Column.MaxAdvertisedDownloadSpeed] ?? "", 10),
		max_advertised_upload_speed: Number.parseInt(columns[Column.MaxAdvertisedUploadSpeed] ?? "", 10),
		low_latency: columns[Column.LowLatency] === "1" ? 1 : 0,
		business_residential_code: columns[Column.BusinessResidentialCode] ?? "",
		geoid: columns[Column.BlockGeoID] ?? "",
	}
}

/**
 * Shared reader options, with CSV defaults that keep a CRLF line ending out of the last column.
 */
const READER_OPTIONS = { mode: "array" } as const

/**
 * Stream an FCC BDC availability CSV, yielding every data row and consuming the header row.
 */
export async function* readAvailabilityRows(
	source: AsyncDataResource,
	providerID: ProviderID
): AsyncIterable<BDCAvailabilityRow> {
	for await (const columns of CSVSpliterator.fromAsync<string[]>(source, READER_OPTIONS)) {
		yield projectRow(columns, providerID)
	}
}

/**
 * Synchronous sibling for an in-memory buffer in fixtures and tests, never the build path.
 */
export function* readAvailabilityRowsSync(
	csvBuffer: Buffer | string,
	providerID: ProviderID
): Iterable<BDCAvailabilityRow> {
	for (const columns of CSVSpliterator.from<string[]>(csvBuffer, READER_OPTIONS)) {
		yield projectRow(columns, providerID)
	}
}
