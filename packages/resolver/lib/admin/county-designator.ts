// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file A `locality` span written as a county with its designator, resolved as the WOF `county` of its region.
 *
 *   The model labels `Harris County` in `Harris County, TX` as `locality`, and no locality of that name is in
 *   Texas, so the lookup returns no candidate or a namesake elsewhere and the region answers. The codex maps
 *   `subregion` to the WOF `county` placetype, and the county's row stores the same name.
 */

import { countyDesignatorsFor, countyNameWithoutDesignator } from "@mailwoman/codex/designators/county"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"

/**
 * The metadata key the walk stamps on a node this fallback resolved.
 * The walk retags such a node `subregion`.
 */
export const COUNTY_DESIGNATOR_FALLBACK = "county_designator_fallback"

/**
 * Where the county is looked for: its country, and the region either as a resolved place id
 * or as the written region qualifier the walk read from the tree.
 */
export interface CountyDesignatorScope {
	country: string
	regionID: number | string | null
	regionQualifier: string | null
	limit: number
}

/**
 * The county of the designated value's name inside its region, with the other counties of that name there.
 *
 * It is `null` when the value has no designator for the country, when the country's
 * counties take a tag other than `subregion` (IE's are WOF regions), when the region
 * is unknown, or when no county of that name is inside it.
 *
 * The whole value is probed first, because WOF keys most US counties as `<name> county` too.
 * The name without its designator is probed second.
 *
 * A hit the backend admitted outside the region (`regionScopeMiss`) is refused.
 */
export async function countyFromDesignatedLocality(
	backend: ResolverBackend,
	value: string,
	scope: CountyDesignatorScope
): Promise<{ top: ResolvedPlace; alternatives: ResolvedPlace[] } | null> {
	// The walk retags a hit `subregion`, the tag of a WOF `county`.
	if (countyDesignatorsFor(scope.country)?.tag !== "subregion") return null

	const bare = countyNameWithoutDesignator(value, scope.country)

	if (!bare) return null

	const regionIDs = await regionIDsFor(backend, scope)

	for (const parentID of regionIDs) {
		for (const text of [value, bare]) {
			const hits = await backend.findPlace({
				text,
				placetype: "county",
				country: scope.country,
				parentID,
				limit: scope.limit,
			})

			const inside = hits.filter((hit) => hit.regionScopeMiss !== true)

			if (inside.length) return { top: inside[0]!, alternatives: inside.slice(1) }
		}
	}

	return null
}

/**
 * The region ids to scope the county probe by: the resolved parent's, or else the
 * exact-match regions the written qualifier names in the country.
 */
async function regionIDsFor(backend: ResolverBackend, scope: CountyDesignatorScope): Promise<Array<number | string>> {
	if (scope.regionID != null) return [scope.regionID]

	const qualifier = scope.regionQualifier?.trim()

	if (!qualifier) return []

	const regions = await backend.findPlace({ text: qualifier, placetype: "region", country: scope.country, limit: 3 })

	return regions.filter((region) => region.exactMatch === true && region.regionScopeMiss !== true).map((r) => r.id)
}
