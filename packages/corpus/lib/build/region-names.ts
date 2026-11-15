// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Every country's first-level division names and abbreviations from the WOF admin database and
 *   libaddressinput's subdivision keys, for the component check's `region:unknown` rule.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { isPresent } from "@mailwoman/core/objects"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street/normalize"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

import { subdivisionWrittenForms } from "#adapters/wof/admin/json/region-codes"

/**
 * The WOF placetypes a row's `region` may name: a region, or the macroregion above it where a country's
 * addresses write that level (England, Scotland, Wales and Northern Ireland are GB macroregions).
 */
const REGION_PLACETYPES = ["region", "macroregion"] as const

/**
 * The folded names and abbreviations of each country's regions.
 */
export interface RegionNames {
	/**
	 * The database the names were read from.
	 */
	path: string
	/**
	 * Whether `region` folds to a name or abbreviation of one of `country`'s regions, or `null`
	 * when neither source holds a region of `country` and the value cannot be judged.
	 */
	holds(country: string, region: string): boolean | null
}

/**
 * The fold the resolver keys its region lookups with.
 */
export const foldRegionName = (name: string): string => normalizeLocalityForKey(name)

/**
 * Reads every current region's `spr` name, `names` rows and `place_abbr` abbreviations, per country.
 *
 * @throws When the database holds no region at all, because an empty table would leave every row unjudged.
 */
export async function readRegionNames(path: PathBuilderLike): Promise<RegionNames> {
	using db = new DatabaseClient<WOFDatabase>(path, { readOnly: true })

	const regions = db
		.selectFrom("spr")
		.select(["id", "country"])
		.where("placetype", "in", REGION_PLACETYPES)
		.where("is_deprecated", "=", 0)

	const rows = await db
		.selectFrom("spr")
		.select(["country", "name"])
		.where("placetype", "in", REGION_PLACETYPES)
		.where("is_deprecated", "=", 0)
		.unionAll(
			db
				.selectFrom("names")
				.innerJoin(regions.as("r"), "r.id", "names.id")
				.select(["r.country as country", "names.name as name"])
		)
		.unionAll(
			db
				.selectFrom("place_abbr")
				.innerJoin(regions.as("r"), "r.id", "place_abbr.id")
				.select(["r.country as country", "place_abbr.abbr as name"])
		)
		.execute()

	const byCountry = new Map<string, Set<string>>()

	for (const row of rows) {
		const country = row.country?.toUpperCase()
		const key = row.name ? foldRegionName(row.name) : ""

		if (!country || !key) continue

		const names = byCountry.get(country) ?? new Set<string>()

		byCountry.set(country, names)
		names.add(key)
	}

	if (!byCountry.size) {
		throw new Error(`${path.toString()} holds no region or macroregion row, so no region value can be judged`)
	}

	// WOF holds few of the postal codes addresses write for a subdivision
	// (Swiss `ZH`, Italian provinces' `TO`, US `PR` and the military `AE`),
	// so libaddressinput's keys and names join each country's set.
	const merged = new Set<string>()

	const namesOf = (country: string): Set<string> | undefined => {
		if (!merged.has(country)) {
			merged.add(country)

			const forms = subdivisionWrittenForms(country).map(foldRegionName).filter(isPresent)

			if (forms.length) {
				byCountry.set(country, new Set([...(byCountry.get(country) ?? []), ...forms]))
			}
		}

		return byCountry.get(country)
	}

	return {
		path: path.toString(),
		holds(country, region) {
			const names = namesOf(country.toUpperCase())

			return names ? names.has(foldRegionName(region)) : null
		},
	}
}

/**
 * The default WOF admin database's region names, or `null` when the database isn't on this host.
 */
export async function tryReadDefaultRegionNames(): Promise<RegionNames | null> {
	const path = wofDatabasePath("admin-global-priority.db")

	return (await pathExists(path)) ? readRegionNames(path) : null
}
