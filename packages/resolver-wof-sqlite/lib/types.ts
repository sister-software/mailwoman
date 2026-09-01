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
 * `@mailwoman/resolver`'s `ResolvedPlace` — `WOFSQLitePlaceLookup` satisfies the generic `ResolverBackend` contract
 * without an adapter shim.
 *
 * `distanceKm` is populated only when the query carried `near` (and the place has a centroid). Useful for downstream
 * UIs that want to show "X km from you" alongside the result.
 */
export interface PlaceCandidate {
	id: number
	name: string
	placetype: WOFPlacetype
	/**
	 * ISO 3166-1 alpha-2 country code.
	 */
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
	 * Combined prominence (population term + best proximity-bias term, same additive units) — populated by the FTS
	 * lookup; the exact-tier sort orders by THIS instead of raw population when the query carried proximity hints
	 * (`near`/`bias`).
	 */
	prominence?: number
	/**
	 * Population from WOF's `wof:population` property. Only present when the candidate has it on record — WOF carries
	 * population for ~15% of localities (mostly larger ones). Absent does NOT mean zero, just unknown.
	 */
	population?: number
	/**
	 * REFERENTIAL likelihood in [0, 1] — `referentialFromPopulation(population)`, the named form of the prominence key
	 * this resolver has always ranked namesakes by (ROAD_TO_V9 §2, ratified 2026-08-06).
	 *
	 * It is a strictly-increasing function of {@link PlaceCandidate.population} below `REFERENTIAL_SATURATION_POPULATION`
	 * and constant above it, so ordering by it — via `compareReferential`, which restores the megacity order with a
	 * population tiebreak — is the SAME ORDER as ordering by population. That equivalence is the point: naming the
	 * ranking key costs nothing at the ranking.
	 *
	 * Absent when the candidate has no population on record, exactly as {@link PlaceCandidate.population} is.
	 */
	referential?: number
	/**
	 * STRICT encyclopedia-evidence importance in [0, 1], fan-out-guarded per #1497 — CARRIED, NEVER RANKED ON.
	 *
	 * RESERVED SLOT awaiting a strict-channel source: present only when a extract's `place_importance` table carries the
	 * split columns, and no shipped extract does — the FTS lookup's clauses emit NULL for everything today. `undefined`
	 * means either "no encyclopedia entry for this place" or "this gazetteer predates the split"; both are absence, and
	 * neither is 0. The BLENDED prior the ranking reads is {@link PlaceCandidate.importance}.
	 *
	 * Saint-Denis is why this is not a ranking key: the Seine-Saint-Denis suburb (pop 96,128) scores 0.1173 while the
	 * Aude hamlet (pop 418) scores 0.5683. Consumers that want to display salience read this; the ranking never does.
	 */
	encyclopedic?: number
	/**
	 * BLENDED global toponym prior in [0, 1] (#28) — `candidate.importance` surfaced verbatim: the score source's legacy
	 * blended importance (encyclopedia-derived where the concordance matched, a population-derived proxy elsewhere).
	 * Emitted only by the candidate-table backend, and only when the artifact measured this place — absent is UNMEASURED,
	 * never zero. Consumed by `rankByImportance` (`resolver/toponym-prior.ts`) for the bare-toponym class. See
	 * `candidate-schema.ts` → `CandidateTable.importance` for why the blend, not the strict channel, is what ships.
	 */
	importance?: number
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
	/**
	 * Admin-containment stamp (#1717 stage 2) — TRI-STATE, mirroring `ResolvedPlace.containedByQualifier` in
	 * `@mailwoman/core`: `true` = the ancestors sidecar vouches this candidate sits under the query's
	 * {@link FindPlaceQuery.regionQualifier}; `false` = evaluated and not vouched for; absent = never evaluated (no
	 * qualifier on the query, or an artifact without the sidecar). Absence is required — the resolver walk reads it as
	 * `unavailable`, never as "not contained".
	 */
	containedByQualifier?: boolean
	/**
	 * The #1882 exemption's firing mark (#1893), mirroring `ResolvedPlace.variantAliasExempted` in `@mailwoman/core`:
	 * present only when this candidate's row would have taken the cross-country alias penalty and the exemption prevented
	 * it. Emitted by the candidate-table backend alone — the WASM FTS lookup never runs the ranker, and its candidates
	 * omit the field (not evaluated, never "did not fire").
	 */
	variantAliasExempted?: true
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
	/**
	 * ISO 3166-1 alpha-2 — narrows to one country.
	 */
	country?: string
	/**
	 * ISO 3166-1 alpha-2 — narrows the TYPO-FUZZY tier only (#1585). Exact and qualifier-strip probes stay worldwide (a
	 * locale hint is a prior, never a hard filter on exact matches), but a typo CORRECTION into a different country's
	 * namespace is nearly always a scrape, so the corrected-key probes honor this scope and a scoped-empty ABSTAINS
	 * rather than falling through to a world-fuzzy candidate. Ignored when `country` is set (already narrower).
	 */
	fuzzyCountry?: string
	/**
	 * Restrict name matching to PRIMARY-keyed rows (#1632) — set by probes whose surface is a RE-READING (a token cut out
	 * of a longer classified span), which never named an alias. See the ResolverBackend contract in
	 * `@mailwoman/core/resolver`.
	 */
	primaryOnly?: boolean
	/**
	 * Alias-row NAME ROLES the probe refuses to answer through (#1730) — the bare-toponym side races pass `abbr`/`gloss`.
	 * Role-NULL alias rows (the exonym tier) stay open; backends/artifacts without a role column ignore it.
	 */
	excludeNameRoles?: readonly string[]
	/**
	 * WOF place id — narrows to descendants of this place.
	 */
	parentID?: number
	/**
	 * Sibling postcode. When set on a `locality` query AND a `postcode_locality` table is present, triggers the
	 * coordinate-first soft-score path: postcode→candidate localities are injected and scored `0.6·S_pc + 0.3·S_name +
	 * 0.1·S_pop` against the FTS name-match set, recovering small localities the name-match alone misses. Ignored when no
	 * postcode_locality extract is present.
	 */
	postcode?: string
	/**
	 * Postcode-containment coherence (#31, Mechanism 2) — when true on a locality query that also carries `postcode`,
	 * candidate rows within `POSTCODE_CONTAINMENT_GATE_KM` of the postcode's own centroid sort by distance first, the
	 * rest appended in their original order. Set by the resolver from `ResolveOpts.postcodeContainmentCoherence`; absent
	 * → the population-first order is untouched (byte-identical).
	 */
	postcodeContainmentCoherence?: boolean
	/**
	 * The tree's parsed REGION qualifier (#1717 stage 2) — set by the resolver on locality lookups when
	 * `ResolveOpts.adminContainmentRerank` is on. See the `ResolverBackend` contract in `@mailwoman/core/resolver`: a
	 * capable backend stamps `containedByQualifier`, ranks contained candidates first, and may ADD contained same-key
	 * candidates a country scope hid — additive only, never a filter. Ignored on an artifact without the ancestors
	 * sidecar (candidates then carry no stamp).
	 */
	regionQualifier?: string
	/**
	 * Proximity hint — candidates close to this point get a ranking boost.
	 */
	near?: GeoPoint & { maxDistanceKm?: number }
	/**
	 * Ordered proximity-bias points (viewport center, user location, …), each optionally weighted (default 1.0, first
	 * entry strongest by convention). SOFT — a re-rank signal, never a filter: with bias present, exact-tier candidates
	 * order by combined prominence (population + the best decayed-distance term over these points) instead of population
	 * alone, which is how an ambiguous bare postcode ("48026": Fraser MI vs Russi IT) follows the map view / the user.
	 * Absent (and no `near`) → ranking is byte-identical to today. `near` is treated as a weight-1.0 bias point for
	 * back-compat.
	 */
	bias?: Array<GeoPoint & { weight?: number }>
	/**
	 * Bounding-box filter — only candidates whose bbox intersects this box are returned.
	 */
	bbox?: GeoBbox
	/**
	 * Default 10.
	 */
	limit?: number
}

/**
 * The pull-based lookup surface. Implementations resolve a `FindPlaceQuery` to a ranked list of `PlaceCandidate`s. The
 * interface is async even though `node:sqlite` is sync — leaves room for `Worker`-backed implementations later without
 * a public API break.
 */
export interface PlaceLookup extends Disposable {
	findPlace(query: FindPlaceQuery): Promise<PlaceCandidate[]>
}
