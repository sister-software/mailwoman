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
	type BDCSpeedTier,
	type BDCStateSubCategory,
	type BDCSummarySubCategory,
	type BDCTechnologyType,
	type RawBDCFile,
} from "#sdk/common"

/**
 * Optional filters the listing endpoint accepts beside `category` and `subcategory`,
 * per the April 2025 BDC Public Data API specification.
 *
 * `speed_tier` is valid for `category=Provider` hexagon and raw coverage.
 */
export interface BDCAvailabilityFileFilters {
	technologyType?: BDCTechnologyType
	speedTier?: BDCSpeedTier
}

export interface RetrieveProviderAvailabilityFilesParams extends BDCAvailabilityFileFilters {
	/**
	 * The filing's `as_of_date`, e.g. from {@linkcode file://./filing-dates.ts#resolveLatestVintage}.
	 */
	asOfDate: string
	category: typeof BDCFileCategory.Provider
	subcategory: BDCProviderSubCategory
}

export interface RetrieveStateAvailabilityFilesParams extends BDCAvailabilityFileFilters {
	asOfDate: string
	category: typeof BDCFileCategory.State
	subcategory: BDCStateSubCategory
}

export interface RetrieveSummaryAvailabilityFilesParams extends BDCAvailabilityFileFilters {
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
 * Lists parsed availability files for a filing date, category and subcategory.
 * Results use revision-date order.
 */
export async function retrieveAvailabilityFiles(
	client: BDCClient,
	{ asOfDate, category, subcategory, technologyType, speedTier }: RetrieveAvailabilityFilesParams
): Promise<BDCFile[]> {
	const pathname = `/map/downloads/listAvailabilityData/${encodeURIComponent(asOfDate)}`

	const body = await client.get<ListAvailabilityDataResponseBody>(pathname, {
		category,
		subcategory,
		technology_type: technologyType,
		speed_tier: speedTier,
	})

	return body.data.map(parseRawBDCFile).toSorted(compareRevisionAsc)
}
