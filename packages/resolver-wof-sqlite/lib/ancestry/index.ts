/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The shared ancestor-lineage walk over the WOF `ancestors` table: one place's containment chain
 *   joined with `spr` for canonical names and centroids, ordered nearest-first with the deepest
 *   placetype first and the country last.
 *
 *   The reverse geocoder and `WOFSQLitePlaceLookup.ancestors()` share this walk. Placetype
 *   specificity lives here in `PLACETYPE_DEPTH`, a single TypeScript map that extends below
 *   `localadmin` so locality, borough, neighbourhood, and microhood rank correctly. Forward
 *   resolution rarely sees those as ancestor placetypes, while reverse geocoding always does.
 */

import { allRows } from "@mailwoman/core/utils"
import type { DatabaseClient } from "@mailwoman/sqlite/client"

/**
 * WOF placetype → containment depth, coarsest = 1.
 *
 * Higher = finer. Placetypes we never resolve (continent, empire, …) map to 0 and sort last.
 *
 * This differs from the FST's `PLACETYPE_ORDER` (fst-serialize.ts), which is a serialization
 * order. This one is containment depth.
 */
export const PLACETYPE_DEPTH: Readonly<Record<string, number>> = {
	country: 1,
	macroregion: 2,
	region: 3,
	macrocounty: 4,
	county: 5,
	localadmin: 6,
	locality: 7,
	borough: 8,
	macrohood: 9,
	neighbourhood: 10,
	microhood: 11,
}

/**
 * Containment depth for a placetype, 0 when unknown (sorts coarsest).
 */
export function placetypeDepth(placetype: string): number {
	return PLACETYPE_DEPTH[placetype] ?? 0
}

/**
 * One ancestor row, enriched with the `spr` columns both consumers need.
 */
export interface AncestorPlaceRow {
	id: number
	placetype: string
	name: string
	country: string
	lat: number
	lon: number
}

/**
 * The ancestor lineage of `id`, self excluded, nearest-first.
 *
 * @returns `[]` when the place has no recorded ancestry.
 * Not memoized here. `WOFSQLitePlaceLookup` keeps its own per-id cache.
 */
export function ancestorLineage<DB>(db: DatabaseClient<DB>, id: number, schemaName = "main"): AncestorPlaceRow[] {
	const rows = allRows<AncestorPlaceRow>(
		db.prepare(
			`SELECT a.ancestor_id AS id, a.ancestor_placetype AS placetype, s.name AS name,
				s.country AS country, s.latitude AS lat, s.longitude AS lon
			FROM ${schemaName}.ancestors a JOIN ${schemaName}.spr s ON s.id = a.ancestor_id
			WHERE a.id = ? AND a.ancestor_id != a.id`
		),
		id
	)

	rows.sort((a, b) => placetypeDepth(b.placetype) - placetypeDepth(a.placetype))

	return rows
}

export * from "#ancestry/backfill"
