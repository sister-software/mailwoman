/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Measures US address coverage per county against an estimate of each county's addressed structures.
 *
 *   The denominator is ACS 2021 five-year table B25024, units in structure, for the county set Who's On First also
 *   holds. A building has one street address for all of its units, so the structure estimate divides each
 *   building-size bucket by its midpoint unit count, and a dense county is measured against its buildings rather than
 *   its apartments.
 *
 *   An address-point database stores a postcode and no county, so a postcode's points are shared among counties by that
 *   postcode's street segments in each county. That attribution is approximate across a county line. A point with no
 *   postcode is counted for its state and left out of every county.
 */

import { APIClient } from "@mailwoman/core/api"

/**
 * The ratio below which the census reports a county as thin: address points
 * under a quarter of its estimated structures.
 *
 * It is a reporting line for sorting source work, and no decision reads it.
 */
export const THIN_COUNTY_RATIO = 0.25

/**
 * The ACS five-year endpoint whose table B25024 the census reads.
 *
 * Its county set must be the one Who's On First holds, because points are placed by Who's On First county.
 * The 2021 release is the last on Connecticut's eight counties.
 * Who's On First holds those eight as current.
 *
 * The 2022 release replaced them with nine planning regions that cross the county lines.
 */
export const ACS_COUNTY_ENDPOINT = "https://api.census.gov/data/2021/acs/acs5"

/**
 * B25024's building-size buckets and the units one structure in each holds, at the bucket's midpoint.
 *
 * Single-unit homes, mobile homes and boats count one unit each.
 * The 50-or-more bucket's 100 is an assumption, because the table states no upper bound.
 */
export const UNITS_PER_STRUCTURE: ReadonlyArray<readonly [variable: string, units: number]> = [
	["B25024_002E", 1],
	["B25024_003E", 1],
	["B25024_004E", 2],
	["B25024_005E", 3.5],
	["B25024_006E", 7],
	["B25024_007E", 14.5],
	["B25024_008E", 34.5],
	["B25024_009E", 100],
	["B25024_010E", 1],
	["B25024_011E", 1],
]

/**
 * One county's housing as B25024 states it: its total units and the structures they are estimated to occupy.
 */
export interface CountyHousing {
	name: string
	housingUnits: number
	structures: number
}

/**
 * One county's measured coverage.
 */
export interface CountyCoverage extends CountyHousing {
	fips: string
	addressPoints: number
	streetSegments: number
}

/**
 * Reads the ACS API's table rows, header first, into housing per county keyed by its five-digit FIPS code.
 *
 * @throws When a column this reader needs is absent, or a count is not a number.
 */
export function readCountyHousing(rows: ReadonlyArray<readonly string[]>): Map<string, CountyHousing> {
	const [header, ...body] = rows

	const at = (name: string) => {
		const index = header?.indexOf(name) ?? -1

		if (index < 0) throw new Error(`The ACS table has columns ${header?.join(", ")}, and ${name} is required`)

		return index
	}

	const name = at("NAME")
	const state = at("state")
	const county = at("county")
	const total = at("B25024_001E")
	const buckets = UNITS_PER_STRUCTURE.map(([variable, units]) => [at(variable), units] as const)

	const count = (row: readonly string[], index: number) => {
		const value = Number(row[index])

		if (!Number.isFinite(value)) throw new Error(`${row[name]}: ${header![index]} is ${row[index]}, not a count`)

		return value
	}

	return new Map(
		body.map((row) => [
			`${row[state]}${row[county]}`,
			{
				name: row[name]!,
				housingUnits: count(row, total),
				structures: buckets.reduce((sum, [index, units]) => sum + count(row, index) / units, 0),
			},
		])
	)
}

/**
 * Fetches B25024 for every US county from the ACS API.
 */
export async function fetchCountyHousing(apiKey: string): Promise<Map<string, CountyHousing>> {
	const client = new APIClient({ displayName: "census-acs", retry: true })
	const variables = ["NAME", "B25024_001E", ...UNITS_PER_STRUCTURE.map(([variable]) => variable)]

	const response = await client.fetch<string[][]>({
		url: ACS_COUNTY_ENDPOINT,
		params: { get: variables.join(","), for: "county:*", key: apiKey },
		timeout: 60_000,
	})

	return readCountyHousing(response.data)
}

/**
 * Shares each postcode's address points among counties by the postcode's street segments.
 *
 * Points under a postcode with no segment have no county, and the result reports them as unattributed.
 */
export function attributePoints(
	pointsByPostcode: ReadonlyMap<string, number>,
	segments: ReadonlyArray<{ postcode: string; county: string; segments: number }>
): { byCounty: Map<string, number>; unattributed: number } {
	const shares = new Map<string, Array<{ county: string; segments: number }>>()

	for (const { postcode, county, segments: count } of segments) {
		shares.set(postcode, [...(shares.get(postcode) ?? []), { county, segments: count }])
	}

	const byCounty = new Map<string, number>()
	let unattributed = 0

	for (const [postcode, points] of pointsByPostcode) {
		const counties = shares.get(postcode)

		if (!counties) {
			unattributed += points

			continue
		}

		const total = counties.map((county) => county.segments).reduce((sum, count) => sum + count, 0)

		for (const { county, segments: count } of counties) {
			byCounty.set(county, (byCounty.get(county) ?? 0) + (points * count) / total)
		}
	}

	return { byCounty, unattributed }
}

/**
 * A county's address points per estimated structure, or null with no structures to divide by.
 */
export function coverageRatio(county: Pick<CountyCoverage, "structures" | "addressPoints">): number | null {
	return county.structures > 0 ? county.addressPoints / county.structures : null
}
