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
}

/**
 * Query against the resolver.
 *
 * `text` is the only required field; everything else narrows the search. When `country` and
 * `parentId` are both set, `parentId` wins (it's more specific).
 */
export interface FindPlaceQuery {
	text: string
	placetype?: WofPlacetype | WofPlacetype[]
	/** ISO 3166-1 alpha-2 — narrows to one country. */
	country?: string
	/** WOF place id — narrows to descendants of this place. */
	parentId?: number
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
