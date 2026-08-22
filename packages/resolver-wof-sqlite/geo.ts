/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Geographic helpers for the resolver, re-exported from `@mailwoman/spatial`. None of them depend on SQLite, so the
 *   math lives there and new code should import it from there directly; this file is the seam the resolver's own
 *   readers already reach for.
 *
 *   We deliberately don't pull SpatiaLite (or turf) for any of it. SQLite's built-in `rtree` virtual table gives bbox
 *   filtering at the SQL level, and the post-fetch passes operate on ≤ a few hundred candidates per query rather than
 *   the whole corpus.
 *
 *   `scripts/eval/pip-containment.py` grades the same containment truth and has to be matched BY HAND if the algorithm
 *   changes — it is the one copy no import can reach.
 *
 *   The R*Tree index name + schema are centralized in `fts.ts` (alongside the FTS5 build).
 */

export {
	bboxAround,
	geometryContains,
	haversineKm,
	pointInPolygonRings,
	pointInRing,
	type GeojsonGeometry,
	type GeojsonMultiPolygon,
	type GeojsonPolygon,
	type GeojsonPosition,
	type LatLonBounds,
} from "@mailwoman/spatial"
