/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file FCC BDC availability-file listing.
 *
 *   Re-homed from Nexus's `sync/fcc/bdc/list-files.ts` (relicense-by-copy, no provenance headers):
 *   the `URLRoutePattern`-compiled route → a plain template literal (this port has no routing
 *   dependency), the `$BCDClient`-bound `retrieveAvailabilityFiles()` → a plain function taking a
 *   {@linkcode BDCClient}. Raw entries are parsed via `parseRawBDCFile` and returned sorted
 *   ascending by revision (`compareRevisionAsc`) rather than in API order.
 */

import type { BDCClient } from "./client.ts"
import {
	compareRevisionAsc,
	parseRawBDCFile,
	type BDCFile,
	type BDCFileCategory,
	type BDCProviderSubCategory,
	type BDCStateSubCategory,
	type BDCSummarySubCategory,
	type RawBDCFile,
} from "./common.ts"

export interface RetrieveProviderAvailabilityFilesParams {
	/**
	 * The filing's `as_of_date`, e.g. from {@linkcode file://./filing-dates.ts#resolveLatestVintage}.
	 */
	asOfDate: string
	category: typeof BDCFileCategory.Provider
	subcategory: BDCProviderSubCategory
}

export interface RetrieveStateAvailabilityFilesParams {
	asOfDate: string
	category: typeof BDCFileCategory.State
	subcategory: BDCStateSubCategory
}

export interface RetrieveSummaryAvailabilityFilesParams {
	asOfDate: string
	category: typeof BDCFileCategory.Summary
	subcategory: BDCSummarySubCategory
}

export type RetrieveAvailabilityFilesParams =
	| RetrieveProviderAvailabilityFilesParams
	| RetrieveStateAvailabilityFilesParams
	| RetrieveSummaryAvailabilityFilesParams

interface ListAvailabilityDataResponseBody {
	data: RawBDCFile[]
}

/**
 * List the BDC availability files for a given `as_of_date`/category/subcategory, parsed into {@linkcode BDCFile}
 * records and sorted ascending by revision date ({@linkcode compareRevisionAsc}).
 */
export async function retrieveAvailabilityFiles(
	client: BDCClient,
	{ asOfDate, category, subcategory }: RetrieveAvailabilityFilesParams
): Promise<BDCFile[]> {
	const pathname = `/map/downloads/listAvailabilityData/${encodeURIComponent(asOfDate)}`

	const body = await client.get<ListAvailabilityDataResponseBody>(pathname, {
		category,
		subcategory,
	})

	return body.data.map(parseRawBDCFile).toSorted(compareRevisionAsc)
}
