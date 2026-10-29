/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Assembles the house-venue tuples input from each country's own register.
 *
 *   Each country reads a different source with a different schema: France a BAN extract, the United States one situs
 *   database per state, Great Britain the `gb-os-open` adapter's rows. Each renders its own surface conventions in
 *   `lib/<cc>/recipes/house-venue-tuples.ts`. This module knows the order the samplers run in, the budget per
 *   country and the output, so adding a country adds a sampler and an entry in {@linkcode HOUSE_VENUE_SAMPLERS}.
 *
 *   The samplers draw from one shared {@linkcode PyRandom}, in {@linkcode HOUSE_VENUE_SAMPLERS} order, as the
 *   Python assembler (`corpora/house_venue_tuples.py`) drew them. A country copied from an earlier file leaves the
 *   generator where it was, so the countries after it draw what they drew when it was sampled.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import type { PathBuilderLike } from "path-ts"
import { JSONSpliterator } from "spliterator"

import { readFRReservedSurfaces, sampleFRHouseVenueTuples } from "#fr/recipes/house-venue-tuples"
import { sampleGBHouseVenueTuples } from "#gb/recipes/house-venue-tuples"
import { PyRandom } from "#training/pyrandom"
import { sampleUSHouseVenueTuples } from "#us/recipes/house-venue-tuples"

/**
 * One house-venue tuple, in the key order the tuples file stores.
 *
 * A GB tuple also records the adapter it came from, which the sub-venue recipe requires.
 */
export interface HouseVenueTuple {
	locality: string
	region: string
	postcode: string
	country: string
	street: string
	houseNumber: string
	source?: string
	sourceID?: string | null
}

/**
 * Draws up to `count` tuples for one country from the shared generator.
 */
export type HouseVenueSampler = (count: number, rng: PyRandom) => Promise<HouseVenueTuple[]>

/**
 * Each country's sampler, in output and draw order.
 */
export const HOUSE_VENUE_SAMPLERS: ReadonlyArray<readonly [code: string, sampler: HouseVenueSampler]> = [
	["fr", async (count, rng) => sampleFRHouseVenueTuples(count, rng, await readFRReservedSurfaces())],
	["us", sampleUSHouseVenueTuples],
	["gb", sampleGBHouseVenueTuples],
]

/**
 * The tuples file the sub-venue recipe reads.
 *
 * v6 keeps NAD rows and the rows of each US body whose own register decision permits training,
 * and carried its GB rows from v4 (`--carry gb --carry-from <v4>`).
 */
export function houseVenueTuplesPath() {
	return dataRootPath("corpus", "intermediate", "house-venue-tuples-v6.jsonl")
}

/**
 * The default budget per country.
 */
export const HOUSE_VENUE_DEFAULT_BUDGET = 60_000

/**
 * The default seed of the shared generator.
 */
export const HOUSE_VENUE_DEFAULT_SEED = 42

/**
 * One country's tuples from an earlier tuples file, in file order.
 *
 * @throws When the file does not exist, or holds no tuple for the country,
 * so a carry never writes an empty part.
 */
export async function readCarriedTuples(path: PathBuilderLike, code: string): Promise<HouseVenueTuple[]> {
	if (!(await pathExists(path))) throw new Error(`No tuples file to carry from at ${path.toString()}`)

	const country = code.toUpperCase()
	const carried: HouseVenueTuple[] = []

	for await (const tuple of JSONSpliterator.fromAsync<HouseVenueTuple>(path)) {
		if (tuple.country === country) {
			carried.push(tuple)
		}
	}

	if (!carried.length) throw new Error(`${path.toString()} holds no ${country} tuple to carry`)

	return carried
}

/**
 * Options for {@linkcode assembleHouseVenueTuples}.
 */
export interface AssembleHouseVenueTuplesOptions {
	/**
	 * Tuples per country code.
	 *
	 * A country absent here gets {@linkcode HOUSE_VENUE_DEFAULT_BUDGET}.
	 */
	budgets?: Readonly<Record<string, number>>
	seed?: number
	/**
	 * Countries copied from `carryFrom` rather than sampled.
	 */
	carry?: readonly string[]
	carryFrom?: PathBuilderLike
	samplers?: typeof HOUSE_VENUE_SAMPLERS
}

/**
 * Every country's tuples, in sampler order, each from its sampler or carried from an earlier file.
 *
 * @throws When a carry names no file to carry from.
 */
export async function assembleHouseVenueTuples(
	options: AssembleHouseVenueTuplesOptions = {}
): Promise<Array<readonly [code: string, tuples: HouseVenueTuple[]]>> {
	const carry = new Set(options.carry)

	if (carry.size && !options.carryFrom) throw new Error("--carry needs --carry-from")

	const rng = new PyRandom(options.seed ?? HOUSE_VENUE_DEFAULT_SEED)
	const parts: Array<readonly [string, HouseVenueTuple[]]> = []

	for (const [code, sample] of options.samplers ?? HOUSE_VENUE_SAMPLERS) {
		const budget = options.budgets?.[code] ?? HOUSE_VENUE_DEFAULT_BUDGET

		if (carry.has(code)) {
			parts.push([code, await readCarriedTuples(options.carryFrom!, code)])
		} else {
			parts.push([code, budget > 0 ? await sample(budget, rng) : []])
		}
	}

	return parts
}
