/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *   @file List FCC BDC availability files by filing date and category. Results are parsed and sorted
 *   by revision date.
 */

import type { BDCClient } from "#sdk/client"
import {
	compareRevisionAsc,
	parseRawBDCFile,
	type BDCFile,
	type BDCFileCategory,
	type BDCProviderSubCategory,
	type BDCStateSubCategory,
	type BDCSummarySubCategory,
	type RawBDCFile,
} from "#sdk/common"

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
 * List parsed availability files for a filing date, category, and subcategory, sorted by revision date.
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
