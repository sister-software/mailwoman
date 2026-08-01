/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file FCC BDC filing-date discovery + vintage resolution.
 *
 *   Re-homed from Nexus's `sync/fcc/bdc/filing-dates.ts` (relicense-by-copy, no provenance
 *   headers): the `$BCDClient`-bound `retrieveFilingDates()` → a plain function taking a
 *   {@linkcode BDCClient}.
 *
 *   CACHING MOVED TO THE CLIENT. Both the Nexus original (one `<filingType>-dates.json` per filing
 *   type) and this port's first cut (`dataRootPath("bdc", "cache", "filing-dates.json")`, unfiltered)
 *   hand-rolled a JSON file cache here. `BDCClient` is built on `APIClient` and now carries an on-disk
 *   response cache of its own, so the hand-rolled one was the exact duplication that migration exists to
 *   remove — and it was worse than what replaced it: it had NO expiry, so a machine that resolved a
 *   vintage once would never see the next one FCC published without an explicit `skipCache`. The
 *   client's cache has a TTL chosen against the filing cadence, and `skipCache` now maps onto a
 *   per-request cache bypass with the same meaning it always had.
 */

import type { BDCClient } from "./client.ts"
import type { BDCFilingDataType } from "./common.ts"

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
	 * Which filing type's dates to return — the full cached/fetched set is filtered down to this type.
	 */
	filingType: BDCFilingDataType
	/**
	 * Bypass the client's response cache and always fetch fresh from the API. Defaults to `false`.
	 */
	skipCache?: boolean
}

/**
 * Retrieve the FCC BDC's available filing `as_of_date`s for a given filing type.
 *
 * One `listAsOfDates` call answers every filing type — the full unfiltered response is what the client caches, and this
 * filters it down on read — so asking for a second filing type inside the TTL costs no request at all. At ten requests
 * per minute that is worth six seconds each time.
 */
export async function retrieveFilingDates(
	client: BDCClient,
	{ filingType, skipCache = false }: RetrieveFilingDatesParams
): Promise<FCCAsOfDateEntry[]> {
	const body = await client.get<ListAsOfDatesResponseBody>("/map/listAsOfDates", undefined, { skipCache })

	return body.data.filter((entry) => entry.data_type === filingType)
}

/**
 * Pick the latest (most recent) `as_of_date` among `entries` for the given `dataType`.
 *
 * Comparison is by parsed `Date` value, not string ordering — the FCC's `as_of_date` values are `date`-formatted
 * (`YYYY-MM-DD`), which happens to sort correctly as strings too, but comparing as dates is the honest contract.
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
