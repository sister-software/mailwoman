/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Grade one row: the admin-match flags plus the great-circle error from the resolved place to OA's own point.
 */

import { expandPlacetypeFilter } from "@mailwoman/resolver"
import { haversineKm } from "@mailwoman/spatial"

import type { LocalityMatcher } from "#eval-harness/oa-resolver/admin-match"
import { regionMatches } from "#eval-harness/oa-resolver/admin-match"
import type { ArmOutcome } from "#eval-harness/oa-resolver/aggregate"
import type { OARow } from "#eval-harness/oa-resolver/rows"
import type { Resolved } from "#eval-harness/oa-resolver/tree-hits"
import { mostSpecific } from "#eval-harness/oa-resolver/tree-hits"

/**
 * One row's outcome, plus the raw resolved names the `--errors-json` dump needs to bucket a miss offline: a
 * present-but-wrong `resolvedLoc` is a resolver ranking/disambiguation miss, an absent one a coverage/parse miss.
 */
export interface RowScore extends ArmOutcome {
	resolvedLoc?: string
	resolvedLocID?: number
	resolvedReg?: string
}

/**
 * Score one resolved tree's places against the row's ground truth.
 *
 * Admin-match is by NAME (OA carries no WOF id): a row matches if OA's expected locality equals the resolved place's
 * canonical name OR any of its WOF altnames (see {@linkcode LocalityMatcher}); region is name-or-abbrev tolerant.
 *
 * The locality node is looked up over the placetypes the resolver's own `locality` tag expands to — locality, borough
 * and localadmin — because New England civil "towns" are `localadmin` in WOF, not `locality`. Mirroring the resolver's
 * `PLACETYPE_FILTER_GROUPS.locality` is what makes this metric count exactly what the resolver treats as a locality;
 * the bare `=== "locality"` filter it replaced silently discarded correct localadmin hits and under-reported rural US
 * locality-match by tens of points (#375 oracle-locality diagnostic).
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
