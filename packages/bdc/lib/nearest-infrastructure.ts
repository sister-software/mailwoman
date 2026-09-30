/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `nearestInfrastructure` — a coverage-paired k-nearest read over the telecom-infrastructure POI
 *   categories (`telecom_exchange`/`tower_comms` — `@mailwoman/poi-taxonomy` categories, populated by the
 *   `--source osm` extractor) that a caller can join against any layer's own `layer_coverage`
 *   survey-completeness table (decision 7). A typical caller is a BDC filing scorer.
 *   It asks for the nearest real infrastructure to a claimed Broadband Serviceable Location.
 *   It also asks whether this layer has survey evidence for that area.
 *
 *   The shapes below follow the interfaces in `poi-lookup.ts` and `@mailwoman/core/layers`:
 *
 *   - **`poiLookup` is an already-open {@link POILookup}.** The caller constructs it from `POILookupOpts` before calling this function. `POILookup`'s constructor eagerly loads the poi-taxonomy category dictionary
 *     and prepares three statements (see `poi-lookup.ts`) — reconstructing that per call would mean
 *     re-opening the SQLite handle and re-running the dictionary `select` on every single
 *     `nearestInfrastructure` invocation. A scorer calls this once per filing candidate. It opens
 *     `poi.db` once and reuses the same `POILookup`. This wrapper accepts that shape: the caller owns
 *     `POILookup`'s open/dispose lifecycle (`using poiLookup = new POILookup(...)`). The wrapper calls
 *     `.search()` on it.
 *   - **`nearestInfrastructure` is `async`, not sync.** `readLayerCoverage`
 *     (`@mailwoman/core/layers`) is `Promise`-returning. Every layer-interface read in this codebase is
 *     (`readLayerManifest`, `filingLandscape` itself) — so pairing each POI hit with its coverage cell
 *     means awaiting one `readLayerCoverage` call per hit. A sync signature can't await that.
 *
 *   {@link res9ShortCellToRes6Parent} (exported by `filing-landscape.ts`; see that file's docstring for
 *   why the res-6 parent is reconstructed from the stored res-9 cell rather than recomputed from the
 *   centroid) turns each hit's res-9 cell into the res-6 cell every layer in this repo aggregates
 *   coverage at (poi.db's own convention; `bdc.db`'s `BDC_COVERAGE_H3_RESOLUTION` matches it
 *   deliberately — see `schema.ts`). `POI_H3_RESOLUTION` (`poi-lookup.ts`) is also 9, so the two layers'
 *   spines agree without this module hardcoding a resolution of its own.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { readLayerCoverage, type CoverageCell, type layerschemahandle } from "@mailwoman/core/layers"
import { POI_H3_RESOLUTION, type POILookup } from "@mailwoman/resolver-wof-sqlite/poi"
import { shortCellToInt, type H3Cell, type PointLiteral } from "@mailwoman/spatial"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { latLngToCell } from "h3-js"

import { res9ShortCellToRes6Parent } from "#filing/landscape"

/**
 * Ring budget default for {@link nearestInfrastructure} — wider than `POILookup`'s own internal
 * `DEFAULT_MAX_RINGS` (16, ≈5.4 km) because telecom infrastructure (central offices, comm towers)
 * is sparser per-area than poi.db's dense categories (cafes, etc.): 32 res-9 rings ≈ 11 km,
 * a BDC-block-scale search radius that gives real infrastructure room to be found without
 * over-restricting callers who do want a tighter budget via `options.maxRings`.
 */
export const NEAREST_INFRASTRUCTURE_DEFAULT_MAX_RINGS = 32

/**
 * One k-nearest telecom-infrastructure hit, paired with the res-6 coverage cell it falls in.
 *
 * `coverage: undefined` means `schemadb`'s layer has never surveyed that area
 * (the meaning-of-zero rule. See `@mailwoman/core/layers`), never conflate it with a covered-but-empty cell.
 */
export interface InfrastructureHit {
	categoryID: string
	name: string | null
	distanceM: number
	/**
	 * Res-9 short H3 cell of the hit itself rather than the (coarser) coverage cell.
	 * See `coverage.h3Cell` for that.
	 */
	h3Cell: number
	coverage: CoverageCell | undefined
}

export interface NearestInfrastructureOptions {
	center: PointLiteral
	/**
	 * Poi-taxonomy category ids to search — fans out to `POILookup.search`'s `categoryIDs`
	 * (union across every resolved leaf, nearest-first).
	 *
	 * Typically `["telecom_exchange", "tower_comms"]`.
	 */
	categoryIDs: string[]
	limit?: number
	/**
	 * Ring budget.
	 *
	 * Default {@link NEAREST_INFRASTRUCTURE_DEFAULT_MAX_RINGS} (32), not `POILookup`'s
	 * own internal default (16); see this module's docstring.
	 */
	maxRings?: number
}

/**
 * K-nearest telecom-infrastructure POIs from `options.center`, each paired with the
 * coverage cell it falls in per `schemadb`'s own `layer_coverage` table.
 *
 * Never throws on a sparse result — no infrastructure within `maxRings`,
 * or every `categoryIDs` entry unresolvable against `poiLookup`'s dictionary —
 * returns `[]`, the same discipline `POILookup.search` itself follows.
 */
export async function nearestInfrastructure(
	poiLookup: POILookup,
	schemadb: layerschemahandle & Pick<DatabaseClient, "destroy">,
	options: NearestInfrastructureOptions
): Promise<InfrastructureHit[]> {
	const [longitude, latitude] = options.center.coordinates

	const hits = poiLookup.search({
		categoryIDs: options.categoryIDs,
		center: { latitude, longitude },
		limit: options.limit,
		maxRings: options.maxRings ?? NEAREST_INFRASTRUCTURE_DEFAULT_MAX_RINGS,
	})

	const infrastructureHits: InfrastructureHit[] = []

	for (const hit of hits) {
		if (hit.categoryID === null) {
			// `categoryIDs` above always constrains the k-ring probe to real (non-zero) category ids
			// (see POILookup#searchKRing), so a hit here always includes the category it was found under.
			// This can't happen without a corrupted poi.db.
			// Guard rather than silently coerce to "".
			throw new Error(`nearestInfrastructure: hit ${stringifyJSON(hit.name)} has no categoryID`)
		}

		const h3Cell = shortCellToInt(latLngToCell(hit.latitude, hit.longitude, POI_H3_RESOLUTION) as H3Cell)
		const coverage = await readLayerCoverage(schemadb, res9ShortCellToRes6Parent(h3Cell))

		infrastructureHits.push({
			categoryID: hit.categoryID,
			name: hit.name,
			// `center` is always supplied above, so POILookup.search always attaches distanceM.
			distanceM: hit.distanceM!,
			h3Cell,
			coverage,
		})
	}

	return infrastructureHits
}
