/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Grades one OpenAddresses row by admin match and by distance from the resolved place to the row's point.
 */

import { expandPlacetypeFilter } from "@mailwoman/codex/placetype-map"
import { haversineKm } from "@mailwoman/spatial"

import type { LocalityMatcher } from "#eval-harness/oa/resolver/admin-match"
import { regionMatches } from "#eval-harness/oa/resolver/admin-match"
import type { ArmOutcome } from "#eval-harness/oa/resolver/aggregate"
import type { OARow } from "#eval-harness/oa/resolver/rows"
import type { Resolved } from "#eval-harness/oa/resolver/tree-hits"
import { mostSpecific } from "#eval-harness/oa/resolver/tree-hits"

/**
 * Outcome for one row, with the resolved names that the `--errors-json` dump uses to classify misses.
 *
 * A wrong `resolvedLoc` points at resolver ranking, and a missing one points at coverage or parsing.
 */
export interface RowScore extends ArmOutcome {
	resolvedLoc?: string
	resolvedLocID?: number
	resolvedReg?: string
}

/**
 * Scores the resolved places for one row against the row's expected admin names and point.
 *
 * Matching is by name because OpenAddresses rows carry no WOF ID. {@linkcode LocalityMatcher}
 * decides the locality match, and `regionMatches` accepts a region name or abbreviation.
 *
 * The locality lookup prefers a `locality` place and falls back to any placetype that
 * the resolver's `locality` filter expands to, such as `localadmin`.
 * New England towns are `localadmin` in WOF, so a `locality`-only lookup would miss them.
 */
export function scoreResolvedRow(row: OARow, resolved: Resolved[], localityMatches: LocalityMatcher): RowScore {
	const best = mostSpecific(resolved)

	const locNode =
		resolved.find((r) => r.placetype === "locality") ??
		resolved.find((r) => expandPlacetypeFilter(["locality"]).includes(r.placetype))

	const locRaw = locNode?.name
	const regResolved = resolved.find((r) => r.placetype === "region")

	return {
		locMatch: localityMatches(row.expected.locality, locNode),
		regMatch: regionMatches(regResolved?.name, row.expected.region),
		resolved: !!best,
		err: best ? haversineKm(best.lat, best.lon, row.lat, row.lon) : null,
		resolvedLoc: locRaw,
		resolvedLocID: locNode?.id,
		resolvedReg: regResolved?.name,
	}
}
