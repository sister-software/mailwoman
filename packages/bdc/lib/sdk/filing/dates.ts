/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *   @file Discover FCC filing dates and select the latest vintage. The client caches the full API
 *   response; `skipCache` requests a fresh response.
 */

import type { BDCClient } from "#sdk/client"
import type { BDCFilingDataType } from "#sdk/common"

/**
 * One entry from the FCC BDC's `/map/listAsOfDates` endpoint.
 */
export interface FCCAsOfDateEntry {
	data_type: BDCFilingDataType
	/**
	 * @format date
	 */
	as_of_date: string
}

interface ListAsOfDatesResponseBody {
	data: FCCAsOfDateEntry[]
}

export interface RetrieveFilingDatesParams {
	/**
	 * Filing type to select from the API response.
	 */
	filingType: BDCFilingDataType
	/**
	 * Bypass the response cache.
	 * Defaults to `false`.
	 */
	skipCache?: boolean
}

/**
 * Return the available filing dates for one type.
 *
 * The API response covers all types and is cached before this function filters it.
 */
export async function retrieveFilingDates(
	client: BDCClient,
	{ filingType, skipCache = false }: RetrieveFilingDatesParams
): Promise<FCCAsOfDateEntry[]> {
	const body = await client.get<ListAsOfDatesResponseBody>("/map/listAsOfDates", undefined, { skipCache })

	return body.data.filter((entry) => entry.data_type === filingType)
}

/**
 * Return the latest filing date for a data type, comparing parsed dates.
 */
export function resolveLatestVintage(entries: readonly FCCAsOfDateEntry[], dataType: BDCFilingDataType): string {
	const matching = entries.filter((entry) => entry.data_type === dataType)

	if (!matching.length) {
		throw new Error(`resolveLatestVintage: no filing-date entries found for data_type "${dataType}"`)
	}

	let latest = matching[0]!

	for (const entry of matching) {
		if (new Date(entry.as_of_date).getTime() > new Date(latest.as_of_date).getTime()) {
			latest = entry
		}
	}

	return latest.as_of_date
}
