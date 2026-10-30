/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Great Britain's house-venue tuples, sampled from the `gb-os-open` adapter's OS OpenData rows.
 *
 *   The adapter joins each Code-Point Open postcode to its nearest named OS Open Roads link and takes the street and
 *   locality from OS Open Names, all under the Open Government Licence v3.0. The house number is one the adapter
 *   drew, because no open GB product publishes one.
 *
 *   The tuples used to come from HM Land Registry Price Paid Data, whose address fields are licensed for personal or
 *   non-commercial use only (#2635). This reader refuses any row whose source and license are not the adapter's,
 *   and any input that is not JSONL.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { stringifyJSON } from "@mailwoman/core/json"
import type { PathBuilderLike } from "path-ts"
import { JSONSpliterator } from "spliterator"

import { GB_OS_OPEN_ADAPTER_ID, gbOSOpenCanonicalRowsPath } from "#gb/adapters/os-open/adapter"
import type { HouseVenueTuple } from "#recipes/house-venue-tuples"
import type { PyRandom } from "#training/pyrandom"

/**
 * The license every accepted row records: the adapter's OGL v3.0 SPDX id.
 */
export const GB_TUPLE_LICENSE = "OGL-UK-3.0"

interface CanonicalRow {
	source?: unknown
	license?: unknown
	source_id?: string | null
	components?: Record<string, unknown> | null
}

/**
 * The input is not the `gb-os-open` adapter's rows, so it may carry Price Paid Data address fields.
 */
export class RefusedGBTupleSourceError extends Error {
	override name = "RefusedGBTupleSourceError"
}

const field = (components: Record<string, unknown>, key: string): string => String(components[key] || "").trim()

/**
 * Up to `count` tuples, reservoir-sampled from the adapter's rows in one streaming pass and then shuffled.
 *
 * The GB layout prints no region, so `region` is empty.
 *
 * @throws {RefusedGBTupleSourceError} When `path` is not a `.jsonl` file,
 * or a row's source or license is not the adapter's.
 * @throws When `path` does not exist, naming it.
 */
export async function sampleGBHouseVenueTuples(
	count: number,
	rng: PyRandom,
	path: PathBuilderLike = gbOSOpenCanonicalRowsPath()
): Promise<HouseVenueTuple[]> {
	const location = path.toString()

	if (!location.endsWith(".jsonl")) {
		throw new RefusedGBTupleSourceError(
			`${location} is not a canonical.jsonl. GB tuples come only from the ${GB_OS_OPEN_ADAPTER_ID} adapter's rows; ` +
				"the Price Paid Data CSV is refused (#2635)."
		)
	}

	if (!(await pathExists(path))) throw new Error(`No ${GB_OS_OPEN_ADAPTER_ID} canonical rows at ${location}`)

	const reservoir: HouseVenueTuple[] = []
	let seen = 0
	let rowNumber = 0

	for await (const row of JSONSpliterator.fromAsync<CanonicalRow>(path)) {
		if (row.source !== GB_OS_OPEN_ADAPTER_ID || row.license !== GB_TUPLE_LICENSE) {
			throw new RefusedGBTupleSourceError(
				`${location} row ${rowNumber} has source ${stringifyJSON(row.source ?? null)} and license ` +
					`${stringifyJSON(row.license ?? null)}; GB tuples accept ${GB_OS_OPEN_ADAPTER_ID} rows under ` +
					`${GB_TUPLE_LICENSE} only.`
			)
		}

		rowNumber++

		const components = row.components ?? {}
		const number = field(components, "house_number")
		const street = field(components, "street")
		const locality = field(components, "locality")
		const postcode = field(components, "postcode")

		if (!(number && street && locality && postcode)) continue

		const tuple: HouseVenueTuple = {
			locality,
			region: "",
			postcode,
			country: "GB",
			street,
			houseNumber: number,
			source: GB_OS_OPEN_ADAPTER_ID,
			sourceID: row.source_id ?? null,
		}

		seen++

		if (reservoir.length < count) {
			reservoir.push(tuple)
		} else {
			const index = rng.randrange(seen)

			if (index < count) {
				reservoir[index] = tuple
			}
		}
	}

	rng.shuffle(reservoir)

	return reservoir
}
