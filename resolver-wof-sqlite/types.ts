/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Public surface for the WOF SQLite resolver — types only, no runtime.
 *
 *   These mirror the conceptual model described in `docs/plan/phases/PHASE_4_2_wof_sqlite.md`. Phase
 *   4.3 will extend `PlaceCandidate` with the resolver-decorated fields that flow into
 *   `AddressNode.source` / `sourceID` (e.g. an explicit `wofURI: "wof-admin:101751113"` form).
 */

/**
 * The placetype taxonomy used by Who's On First. Ordered roughly from coarsest (country) to finest (address). See
 * https://github.com/whosonfirst/whosonfirst-placetypes for the authoritative definitions of each.
 *
 * Phase 4.2 only emits the ones we actually look up; the union is open enough to extend later.
 */
export type WOFPlacetype =
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
 * `score` is the post-boost ranking number — higher is better, but the scale is implementation- defined. Callers should
 * treat it as ordinal, not absolute.
 *
 * `id` is the WOF place id. It's named generically (not `wof_id`) so the shape stays structurally compatible with
 * `@mailwoman/resolver`'s `ResolvedPlace` — `WOFSqlitePlaceLookup` satisfies the generic `ResolverBackend` contract
 * without an adapter shim.
 *
 * `distanceKm` is populated only when the query carried `near` (and the place has a centroid). Useful for downstream
 * UIs that want to show "X km from you" alongside the result.
 */
export interface PlaceCandidate {
	id: number
	name: string
	placetype: WOFPlacetype
	/** ISO 3166-1 alpha-2 country code. */
	country: string
	lat: number
	lon: number
	parent_id?: number
	score: number
	distanceKm?: number
	/**
	 * True when this candidate's name OR an alias EXACTLY equals the query (the exact-match tier from
	 * {@link RankingWeights.exactMatchTiering}). Surfaced so a downstream country re-rank (#369's postcode anchor in
	 * `resolveTree`) can pin the country without crossing the tier — see the `exactMatch` field on `@mailwoman/core`'s
	 * `ResolvedPlace`.
	 */
	exactMatch?: boolean
	/**
	 * Population from WOF's `wof:population` property. Only present when the candidate has it on record — WOF carries
	 * population for ~15% of localities (mostly larger ones). Absent does NOT mean zero, just unknown.
	 */
	population?: number
	/**
	 * Bounding box from WOF's `spr.{min,max}_{latitude,longitude}` columns. Coarse outline for the place — a city's bbox
	 * is the city's full extent, a postcode's is roughly the postcode polygon's envelope. Optional because not all
	 * callers ask for it; implementations are free to omit when the underlying schema lacks the columns.
	 */
	bbox?: GeoBbox
	/**
	 * Set by the coordinate-first path when the chosen locality and the sibling postcode's containing locality are
	 * geographically far apart — the postcode and the parsed city name disagree (a transposed / wrong-for-the-city
	 * postcode). The candidate is still returned (the name wins for the locality), but the flag lets callers lower
	 * confidence / surface the conflict rather than silently mislocate. A retrieval/BM25 geocoder can't raise this — it's
	 * the falsehood-detection differentiator.
	 */
	mismatch?: boolean
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
 * `text` is the only required field; everything else narrows the search. When `country` and `parentID` are both set,
 * `parentID` wins (it's more specific).
 *
 * `near` and `bbox` are independent. `near` is a soft signal — candidates close to the point get a ranking boost but
 * distant candidates aren't dropped. `bbox` is a hard filter — only candidates whose bbox intersects the query bbox are
 * returned (uses the package-built R*Tree index when present; if the index is missing the option is silently ignored to
 * preserve backwards compatibility).
 *
 * `near` may carry `maxDistanceKm` to escalate from a boost to a hard filter — candidates further than that distance
 * from the point are dropped at the SQL level via an R*Tree pre-filter.
 */
export interface FindPlaceQuery {
	text: string
	placetype?: WOFPlacetype | WOFPlacetype[]
	/** ISO 3166-1 alpha-2 — narrows to one country. */
	country?: string
	/** WOF place id — narrows to descendants of this place. */
	parentID?: number
	/**
	 * Sibling postcode. When set on a `locality` query AND a `postcode_locality` table is present, triggers the
	 * coordinate-first soft-score path: postcode→candidate localities are injected and scored `0.6·S_pc + 0.3·S_name +
	 * 0.1·S_pop` against the FTS name-match set, recovering small localities the name-match alone misses. Ignored when no
	 * postcode_locality shard is present.
	 */
	postcode?: string
	/** Proximity hint — candidates close to this point get a ranking boost. */
	near?: GeoPoint & { maxDistanceKm?: number }
	/** Bounding-box filter — only candidates whose bbox intersects this box are returned. */
	bbox?: GeoBbox
	/** Default 10. */
	limit?: number
}

/**
 * The pull-based lookup surface. Implementations resolve a `FindPlaceQuery` to a ranked list of `PlaceCandidate`s. The
 * interface is async even though `node:sqlite` is sync — leaves room for `Worker`-backed implementations later without
 * a public API break.
 */
export interface PlaceLookup {
	findPlace(query: FindPlaceQuery): Promise<PlaceCandidate[]>
	close(): void
}
