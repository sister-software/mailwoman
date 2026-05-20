/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Resolver interface for Phase 4.3 — wires the address-component decoder to a place-id / coordinate
 *   lookup backend.
 *
 *   The interface is deliberately decoupled from any specific resolver implementation. The first
 *   shipped impl is `@mailwoman/resolver-wof-sqlite`, but the same contract supports a future
 *   `RemoteResolver` adapter (Phase 4.4 — Pelias / BAN / Nominatim) without a public-API break.
 *
 *   See `docs/plan/phases/PHASE_4_3_resolver_integration.md` for the design intent.
 */

import type { AddressTree, ComponentTag } from "../decoder/types.js"

/**
 * One candidate place returned by a resolver. Mirrors the shape used by
 * `@mailwoman/resolver-wof-sqlite`'s `PlaceCandidate` — kept structurally compatible so a callsite
 * holding a `PlaceCandidate` can be passed where a `ResolvedPlace` is expected.
 */
export interface ResolvedPlace {
	/** Resolver-specific place identifier (e.g. WOF id). */
	id: number | string
	/** Canonical name of the place as the resolver knows it. */
	name: string
	/** Resolver's placetype taxonomy label (e.g. WOF's `country` / `region` / `locality`). */
	placetype: string
	/** ISO 3166-1 alpha-2 country code, if known. */
	country: string
	/** Centroid latitude in WGS-84 decimal degrees. */
	lat: number
	/** Centroid longitude in WGS-84 decimal degrees. */
	lon: number
	/** Parent place id within the resolver's hierarchy, if any. */
	parent_id?: number | string
	/**
	 * Resolver-defined ranking score. Higher = better fit for the query. Scale is implementation-
	 * defined; callers should treat as ordinal.
	 */
	score: number
}

/**
 * Pull-based contract for a single resolver query. The resolver knows nothing about `AddressTree` —
 * it just answers "what place is named X, optionally constrained by Y?"
 *
 * Structurally compatible with `PlaceLookup` from `@mailwoman/resolver-wof-sqlite` so the latter
 * satisfies this interface without an adapter shim.
 */
export interface ResolverBackend {
	findPlace(query: {
		text: string
		placetype?: string | string[]
		country?: string
		parentId?: number | string
		limit?: number
	}): Promise<ResolvedPlace[]>
}

/**
 * Options for `resolveTree`. All optional with sensible defaults.
 */
export interface ResolveOpts {
	/**
	 * Hard cap on how many backend lookups one tree may issue. Default 10. Prevents a tree with
	 * dozens of candidate nodes from triggering dozens of queries.
	 */
	maxLookups?: number
	/**
	 * Minimum candidate score before resolver attribution wins over the classifier's. Default 0. A
	 * higher threshold makes the resolver more conservative — it leaves more nodes with classifier
	 * provenance. Score scale is implementation-defined; tune per backend.
	 */
	minWinningScore?: number
	/**
	 * Maximum candidates to request from the backend per lookup. Default 5 — we only use the top
	 * candidate after post-scoring, but the backend may benefit from over-fetching for ranking.
	 */
	candidatesPerLookup?: number
	/**
	 * Override the default ComponentTag → resolver-placetype mapping. When set, this map FULLY
	 * REPLACES `DEFAULT_PLACETYPE_MAP` — start from the default by spreading it (`{
	 * ...DEFAULT_PLACETYPE_MAP, ... }`) if you want to extend rather than replace. The fully-
	 * replacing semantics let callers narrow the resolver scope (e.g. drop `locality` if the backend
	 * doesn't ship locality data for the current locale) without awkward `undefined`-as-delete
	 * tricks.
	 */
	placetypeMap?: PlacetypeMap
	/**
	 * Optional locale hint. Currently unused by the v1 resolver but reserved so the contract doesn't
	 * break when locale-aware resolvers land in 4.4+.
	 */
	locale?: string
}

/**
 * Mapping from mailwoman's address-component tags to the resolver's placetype taxonomy. Components
 * not present in the map are NOT queried — the resolver pass leaves their classifier attribution
 * untouched.
 *
 * Phase 4.3 default ships the obvious admin-level mappings; other tags (postcode, street, venue,
 * dependent_locality, prefecture, etc.) are explicitly omitted because:
 *
 * - `postcode` lives in a separate WOF shard (Phase 4.3.x follow-up via the postalcode loader).
 * - `street` / `house_number` aren't in WOF admin — would need OSM / OpenAddresses gazetteers and
 *   license diligence (Phase 4.4 candidate).
 * - Non-US JP-specific tags wait on a different shard entirely.
 */
export type PlacetypeMap = Partial<Record<ComponentTag, string>>

export const DEFAULT_PLACETYPE_MAP: PlacetypeMap = {
	country: "country",
	region: "region",
	locality: "locality",
	// `postcode` (mailwoman tag) maps to WOF's `postalcode` placetype. Resolves only when the
	// backend has the postcode shard available — `WofSqlitePlaceLookup` auto-routes `postalcode`
	// queries to a `postalcode_us` (or similarly-named) shard, falling back to main if absent.
	postcode: "postalcode",
}

/**
 * The interface implemented by `createWofResolver` and any future resolver factories.
 *
 * `resolveTree` returns a NEW `AddressTree` rather than mutating — keeps the input safe to inspect
 * after the call. The new tree's `roots` are fresh `AddressNode` objects; nodes the resolver didn't
 * touch are structurally cloned with their classifier attribution preserved.
 */
export interface Resolver {
	resolveTree(tree: AddressTree, opts?: ResolveOpts): Promise<AddressTree>
}
