/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Public surface for the WOF SQLite resolver — types only, no runtime.
 *
 *   These mirror the conceptual model described in `docs/plan/phases/PHASE_4_2_wof_sqlite.md`. Phase
 *   4.3 will extend `PlaceCandidate` with the resolver-decorated fields that flow into
 *   `AddressNode.source` / `sourceId` (e.g. an explicit `wofUri: "wof-admin:101751113"` form).
 */

/**
 * The placetype taxonomy used by Who's On First. Ordered roughly from coarsest (country) to finest
 * (address). See https://github.com/whosonfirst/whosonfirst-placetypes for the authoritative
 * definitions of each.
 *
 * Phase 4.2 only emits the ones we actually look up; the union is open enough to extend later.
 */
export type WofPlacetype =
	| "country"
	| "macroregion"
	| "region"
	| "macrocounty"
	| "county"
	| "localadmin"
	| "locality"
	| "borough"
	| "neighbourhood"
	| "microhood"
	| "postalcode"
	| "venue"
	| "campus"
	| "address"

/**
 * One candidate match for a place lookup.
 *
 * `score` is the post-boost ranking number — higher is better, but the scale is implementation-
 * defined. Callers should treat it as ordinal, not absolute.
 *
 * `id` is the WOF place id. It's named generically (not `wof_id`) so the shape stays structurally
 * compatible with `@mailwoman/core/resolver`'s `ResolvedPlace` — `WofSqlitePlaceLookup` satisfies
 * the generic `ResolverBackend` contract without an adapter shim.
 *
 * `distanceKm` is populated only when the query carried `near` (and the place has a centroid).
 * Useful for downstream UIs that want to show "X km from you" alongside the result.
 */
export interface PlaceCandidate {
	id: number
	name: string
	placetype: WofPlacetype
	/** ISO 3166-1 alpha-2 country code. */
	country: string
	lat: number
	lon: number
	parent_id?: number
	score: number
	distanceKm?: number
	/**
	 * Population from WOF's `wof:population` property. Only present when the candidate has it on
	 * record — WOF carries population for ~15% of localities (mostly larger ones). Absent does NOT
	 * mean zero, just unknown.
	 */
	population?: number
	/**
	 * Bounding box from WOF's `spr.{min,max}_{latitude,longitude}` columns. Coarse outline for the
	 * place — a city's bbox is the city's full extent, a postcode's is roughly the postcode polygon's
	 * envelope. Optional because not all callers ask for it; implementations are free to omit when
	 * the underlying schema lacks the columns.
	 */
	bbox?: GeoBbox
}

/**
 * A WGS-84 lat/lon point. Used as a proximity hint for `FindPlaceQuery.near`.
 */
export interface GeoPoint {
	lat: number
	lon: number
}

/**
 * A WGS-84 bounding box. Used as a hard filter via `FindPlaceQuery.bbox`.
 */
export interface GeoBbox {
	minLat: number
	maxLat: number
	minLon: number
	maxLon: number
}

/**
 * Query against the resolver.
 *
 * `text` is the only required field; everything else narrows the search. When `country` and
 * `parentId` are both set, `parentId` wins (it's more specific).
 *
 * `near` and `bbox` are independent. `near` is a soft signal — candidates close to the point get a
 * ranking boost but distant candidates aren't dropped. `bbox` is a hard filter — only candidates
 * whose bbox intersects the query bbox are returned (uses the package-built R*Tree index when
 * present; if the index is missing the option is silently ignored to preserve backwards
 * compatibility).
 *
 * `near` may carry `maxDistanceKm` to escalate from a boost to a hard filter — candidates further
 * than that distance from the point are dropped at the SQL level via an R*Tree pre-filter.
 */
export interface FindPlaceQuery {
	text: string
	placetype?: WofPlacetype | WofPlacetype[]
	/** ISO 3166-1 alpha-2 — narrows to one country. */
	country?: string
	/** WOF place id — narrows to descendants of this place. */
	parentId?: number
	/** Proximity hint — candidates close to this point get a ranking boost. */
	near?: GeoPoint & { maxDistanceKm?: number }
	/** Bounding-box filter — only candidates whose bbox intersects this box are returned. */
	bbox?: GeoBbox
	/** Default 10. */
	limit?: number
}

/**
 * The pull-based lookup surface. Implementations resolve a `FindPlaceQuery` to a ranked list of
 * `PlaceCandidate`s. The interface is async even though `node:sqlite` is sync — leaves room for
 * `Worker`-backed implementations later without a public API break.
 */
export interface PlaceLookup {
	findPlace(query: FindPlaceQuery): Promise<PlaceCandidate[]>
	close(): void
}
