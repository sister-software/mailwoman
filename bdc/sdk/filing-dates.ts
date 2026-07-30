/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file FCC BDC filing-date discovery + vintage resolution.
 *
 *   Re-homed from Nexus's `sync/fcc/bdc/filing-dates.ts` (relicense-by-copy, no provenance
 *   headers): `dataSourcePathBuilder` → `dataRootPath` (`@mailwoman/core/utils`), the
 *   `$BCDClient`-bound `retrieveFilingDates()` → a plain function taking a {@linkcode BDCClient}.
 *   Unlike the Nexus original (which cached one `<filingType>-dates.json` file per filing type),
 *   this port caches the FULL unfiltered `listAsOfDates` response at a single path
 *   (`dataRootPath("bdc", "cache", "filing-dates.json")`) and filters by `filingType` on read —
 *   one cache file serves every filing type.
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"

import { dataRootPath } from "@mailwoman/core/utils"

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
	 * Bypass the on-disk cache and always fetch fresh from the API. Defaults to `false`.
	 */
	skipCache?: boolean
}

/**
 * The on-disk cache path for the full (unfiltered) `listAsOfDates` response.
 */
function filingDatesCachePath(): string {
	return dataRootPath("bdc", "cache", "filing-dates.json")
}

/**
 * Retrieve the FCC BDC's available filing `as_of_date`s for a given filing type, caching the full unfiltered response
 * to disk so repeat calls (across filing types) don't re-hit the network.
 */
export async function retrieveFilingDates(
	client: BDCClient,
	{ filingType, skipCache = false }: RetrieveFilingDatesParams
): Promise<FCCAsOfDateEntry[]> {
	const cachePath = filingDatesCachePath()

	if (!skipCache) {
		const cached = await fs.readFile(cachePath, "utf8").catch(() => null)

		if (cached) {
			const entries = JSON.parse(cached) as FCCAsOfDateEntry[]

			return entries.filter((entry) => entry.data_type === filingType)
		}
	}

	const body = await client.get<ListAsOfDatesResponseBody>("/map/listAsOfDates")
	const entries = body.data

	await fs.mkdir(path.dirname(cachePath), { recursive: true })
	await fs.writeFile(cachePath, JSON.stringify(entries, null, "\t"))

	return entries.filter((entry) => entry.data_type === filingType)
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
