/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `nearestInfrastructure` — a coverage-paired k-nearest read over the telecom-infrastructure POI
 *   categories (`telecom_exchange`/`tower_comms` — `@mailwoman/poi-taxonomy` categories, populated by the
 *   `--source osm` extractor) that a caller can join against ANY layer's own `layer_coverage`
 *   survey-completeness table (decision 7). Typical caller: a BDC filing scorer that wants "what's the
 *   nearest real infrastructure to this claimed Broadband Serviceable Location, and does OUR layer even
 *   have survey evidence for that area" in one call.
 *
 *   Two shapes below are not the obvious ones, and both are forced by what `poi-lookup.ts` and
 *   `@mailwoman/core/layers` actually expose:
 *
 *   - **`poiLookup` is an already-open {@link POILookup}, not a `POILookupOpts` this function
 *     constructs itself.** `POILookup`'s constructor eagerly loads the poi-taxonomy category dictionary
 *     and prepares three statements (see `poi-lookup.ts`) — reconstructing that per call would mean
 *     re-opening the SQLite handle and re-running the dictionary `SELECT` on every single
 *     `nearestInfrastructure` invocation. A scorer calling this once per filing candidate wants to open
 *     `poi.db` ONCE and reuse the same `POILookup` — this wrapper takes that shape: the caller owns
 *     `POILookup`'s open/dispose lifecycle (`using poiLookup = new POILookup(...)`), we just call
 *     `.search()` on it.
 *   - **`nearestInfrastructure` is `async`, not sync.** `readLayerCoverage`
 *     (`@mailwoman/core/layers`) is `Promise`-returning — every layer-contract read in this codebase is
 *     (`readLayerManifest`, `filingLandscape` itself) — so pairing each POI hit with its coverage cell
 *     means awaiting one `readLayerCoverage` call per hit. A sync signature can't await that.
 *
 *   {@link res9ShortCellToRes6Parent} (exported by `filing-landscape.ts`; see that file's docstring for
 *   why the res-9 → res-6 reconstruction is a straight concatenation, not `@mailwoman/spatial`'s
 *   `expandH3Cell`) turns each hit's res-9 cell into the res-6 cell every layer in this repo aggregates
 *   coverage at (poi.db's own convention; `bdc.db`'s `BDC_COVERAGE_H3_RESOLUTION` matches it
 *   deliberately — see `schema.ts`). `POI_H3_RESOLUTION` (`poi-lookup.ts`) is ALSO 9, so the two layers'
 *   spines agree without this module hardcoding a resolution of its own.
 */

import type { DatabaseClient } from "@mailwoman/core/kysley/client"
import { readLayerCoverage, type CoverageCell, type LayerContractDatabase } from "@mailwoman/core/layers"
import { POI_H3_RESOLUTION, type POILookup } from "@mailwoman/resolver-wof-sqlite/poi-lookup"
import { shortCellToInt, type H3Cell, type PointLiteral } from "@mailwoman/spatial"
import { latLngToCell } from "h3-js"

import { res9ShortCellToRes6Parent } from "./filing-landscape.ts"

/**
 * Ring budget default for {@link nearestInfrastructure} — wider than `POILookup`'s own internal `DEFAULT_MAX_RINGS`
 * (16, ≈5.4 km) because telecom infrastructure (central offices, comm towers) is sparser per-area than poi.db's dense
 * categories (cafes, etc.): 32 res-9 rings ≈ 11 km, a BDC-block-scale search radius that gives real infrastructure room
 * to be found without over-restricting callers who DO want a tighter budget via `options.maxRings`.
 */
export const NEAREST_INFRASTRUCTURE_DEFAULT_MAX_RINGS = 32

/**
 * One k-nearest telecom-infrastructure hit, paired with the res-6 coverage cell it falls in. `coverage: undefined`
 * means `contractDB`'s layer has never surveyed that area (the meaning-of-zero rule; see `@mailwoman/core/layers`) —
 * never conflate it with a covered-but-empty cell.
 */
export interface InfrastructureHit {
	categoryID: string
	name: string | null
	distanceM: number
	/**
	 * Res-9 short H3 cell of the hit ITSELF — not the (coarser) coverage cell; see `coverage.h3Cell` for that.
	 */
	h3Cell: number
	coverage: CoverageCell | undefined
}

export interface NearestInfrastructureOptions {
	center: PointLiteral
	/**
	 * Poi-taxonomy category ids to search — fans out to `POILookup.search`'s `categoryIDs` (union across every resolved
	 * leaf, nearest-first). Typically `["telecom_exchange", "tower_comms"]`.
	 */
	categoryIDs: string[]
	limit?: number
	/**
	 * Ring budget. Default {@link NEAREST_INFRASTRUCTURE_DEFAULT_MAX_RINGS} (32) — NOT `POILookup`'s own internal default
	 * (16); see this module's docstring.
	 */
	maxRings?: number
}

/**
 * K-nearest telecom-infrastructure POIs from `options.center`, each paired with the coverage cell it falls in per
 * `contractDB`'s own `layer_coverage` table. Never throws on a sparse result — no infrastructure within `maxRings`, or
 * every `categoryIDs` entry unresolvable against `poiLookup`'s dictionary — returns `[]`, the same discipline
 * `POILookup.search` itself follows.
 */
export async function nearestInfrastructure(
	poiLookup: POILookup,
	contractDB: DatabaseClient<LayerContractDatabase>,
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
			// `categoryIDs` above always constrains the k-ring probe to real (non-zero) category ids (see
			// POILookup#searchKRing), so a hit here always carries the category it was found under — this
			// can't happen without a corrupted poi.db. Guard rather than silently coerce to "".
			throw new Error(`nearestInfrastructure: hit ${JSON.stringify(hit.name)} has no categoryID`)
		}

		const h3Cell = shortCellToInt(latLngToCell(hit.latitude, hit.longitude, POI_H3_RESOLUTION) as H3Cell)
		const coverage = await readLayerCoverage(contractDB, res9ShortCellToRes6Parent(h3Cell))

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
