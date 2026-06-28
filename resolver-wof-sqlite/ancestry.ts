/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The shared ancestor-lineage walk over the WOF `ancestors` table — one place's containment chain
 *   joined with `spr` for canonical names + centroids, ordered NEAREST-FIRST (deepest placetype
 *   first, country last).
 *
 *   Factored out of `WofSqlitePlaceLookup.ancestors()` (#404) so the reverse geocoder (`reverse.ts`,
 *   #484) reuses the SAME walk instead of growing a second one. The placetype-specificity ordering
 *   lives here as `PLACETYPE_DEPTH` — a single TS map instead of the previous SQL CASE, and
 *   extended below `localadmin` (locality/borough/neighbourhood/microhood now rank correctly
 *   instead of sorting last; forward resolution rarely saw those as ANCESTOR placetypes, reverse
 *   geocoding always does).
 */

import type { DatabaseSync } from "node:sqlite"

/**
 * WOF placetype → containment depth, coarsest = 1. Higher = finer. Placetypes we never resolve (continent, empire, …)
 * map to 0 and sort last. NOT the same table as the FST's `PLACETYPE_ORDER` (fst-serialize.ts) — that one is a
 * serialization order, this one is containment depth.
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

/** Containment depth for a placetype — 0 (sorts coarsest) when unknown. */
export function placetypeDepth(placetype: string): number {
	return PLACETYPE_DEPTH[placetype] ?? 0
}

/** One ancestor row, enriched with the `spr` columns both consumers need. */
export interface AncestorPlaceRow {
	id: number
	placetype: string
	name: string
	country: string
	lat: number
	lon: number
}

/**
 * The ancestor lineage of `id` — self excluded, nearest-first. Returns `[]` when the place has no recorded ancestry.
 * NOT memoized here; `WofSqlitePlaceLookup` keeps its own per-id cache.
 */
export function ancestorLineage(db: DatabaseSync, id: number, schemaName = "main"): AncestorPlaceRow[] {
	const rows = db
		.prepare(
			`SELECT a.ancestor_id AS id, a.ancestor_placetype AS placetype, s.name AS name,
				s.country AS country, s.latitude AS lat, s.longitude AS lon
			FROM ${schemaName}.ancestors a JOIN ${schemaName}.spr s ON s.id = a.ancestor_id
			WHERE a.id = ? AND a.ancestor_id != a.id`
		)
		.all(id) as unknown as AncestorPlaceRow[]
	rows.sort((a, b) => placetypeDepth(b.placetype) - placetypeDepth(a.placetype))

	return rows
}
