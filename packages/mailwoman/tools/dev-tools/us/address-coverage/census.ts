// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Measures US address coverage per county against the 2010 Census count of housing units.
 *
 *   An address-point database stores a postcode and no county, so a postcode's points are shared among counties by that
 *   postcode's street segments in each county. That attribution is approximate across a county line. A point with no
 *   postcode is counted for its state and left out of every county.
 */

import { readUnquotedTSVText } from "@mailwoman/core/fs/delimited"

/**
 * The ratio below which the census reports a county as thin.
 *
 * It is a reporting line for sorting source work, and no decision reads it.
 */
export const THIN_COUNTY_RATIO = 0.25

/**
 * The Census gazetteer file holding each county's 2010 housing units.
 * It needs no API key, as the current count does.
 */
export const COUNTY_GAZETTEER_URL =
	"https://www2.census.gov/geo/docs/maps-data/data/gazetteer/Gaz_counties_national.zip"

/**
 * One county's measured coverage.
 */
export interface CountyCoverage {
	fips: string
	housingUnits: number
	addressPoints: number
	streetSegments: number
}

/**
 * Reads the gazetteer's tab-delimited table into housing units per county.
 *
 * @throws When the table lacks a column this reader needs.
 */
export function readCountyHousingUnits(table: string): Map<string, number> {
	const [header, ...rows] = [...readUnquotedTSVText(table)].map((row) => row.map((cell) => cell.trim()))

	const geoid = header?.indexOf("GEOID") ?? -1
	const units = header?.indexOf("HU10") ?? -1

	if (geoid < 0 || units < 0) {
		throw new Error(`The gazetteer has columns ${header?.join(", ")}, and GEOID and HU10 are required`)
	}

	return new Map(rows.map((row) => [row[geoid]!, Number(row[units])]))
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
 * The share of a county's housing units its address points would cover,
 * or null with no housing units to divide by.
 */
export function coverageRatio(county: Pick<CountyCoverage, "housingUnits" | "addressPoints">): number | null {
	return county.housingUnits > 0 ? county.addressPoints / county.housingUnits : null
}
