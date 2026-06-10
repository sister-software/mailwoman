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
	/**
	 * Set by the backend when this candidate is an EXACT name/alias match for the query (vs a partial
	 * token match). The postcode-anchor re-rank (#369) uses it as the PRIMARY key so a country
	 * posterior can pin the country WITHOUT crossing the exact-match tier: "ME" under a confident US
	 * posterior stays Maine (US exact) rather than promoting the more-populous Missouri (US partial),
	 * and still beats Messina (IT exact) on the posterior WITHIN the exact tier. Absent → treated as
	 * non-exact (backends that don't tier omit it; the re-rank degrades to a plain score+posterior).
	 */
	exactMatch?: boolean
	/**
	 * Set when the resolver detected that the address's postcode and its parsed locality name point
	 * to geographically different places (a transposed / wrong-for-the-city postcode). Surfaced onto
	 * the resolved node's metadata as `postcode_city_mismatch` so callers can lower confidence or
	 * flag the conflict instead of silently mislocating.
	 */
	mismatch?: boolean
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
		/**
		 * Sibling postcode string, when the address carries one. A coordinate-first backend uses it to
		 * inject postcode-proximal locality candidates (the postcode→locality table) and soft-score
		 * them against the parsed name — recovering localities the name-match alone misses. Backends
		 * without postcode support ignore it.
		 */
		postcode?: string
		limit?: number
	}): Promise<ResolvedPlace[]>
	/**
	 * The dual-role locality (or localities) coincident with an admin place id, from the precomputed
	 * coincident-roles relation (#403). Drives {@link ResolveOpts.hierarchyCompletion}: when the parse
	 * drops the locality of a city-state / capital-seat region, the resolver completes it from here
	 * instead of re-querying. OPTIONAL — backends without the relation omit it, and completion
	 * no-ops. Synchronous: it's an in-memory map lookup once the relation is loaded.
	 */
	coincidentLocalitiesFor?(adminId: number | string): CoincidentLocality[]
	/**
	 * The ancestor lineage of a resolved place — its containment chain (county → region → country),
	 * nearest-first. Backs {@link ResolveOpts.includeAncestors} (#404): the Pelias/Nominatim
	 * "always-attach-the-hierarchy" enrichment. OPTIONAL — backends without it omit it, and the
	 * attachment is skipped. Synchronous: a memoized read of the gazetteer's `ancestors` table.
	 */
	ancestors?(id: number | string): Ancestor[]
}

/** One link in a resolved place's containment lineage ({@link ResolverBackend.ancestors}, #404). */
export interface Ancestor {
	id: number | string
	placetype: string
	name: string
}

/**
 * A dual-role locality returned by {@link ResolverBackend.coincidentLocalitiesFor} — a resolved
 * place (so it can decorate a node directly) plus the relation metadata the completion step
 * disambiguates on.
 */
export interface CoincidentLocality extends ResolvedPlace {
	/**
	 * `city-state` / `capital-seat` / `consolidated-county` — surfaced as
	 * `metadata.relationship_type`.
	 */
	relationshipType: string
	/** Locality population (0 when unknown) — the PRIMARY disambiguator when an admin has several. */
	population: number
	/** Centroid distance (km) admin↔locality from the relation — the population tiebreak. */
	distanceKm: number
}

/**
 * Options for `resolveTree`. All optional with sensible defaults.
 */
/**
 * One exact address-point hit (#476): a real situs coordinate for `(street, number)` within a
 * postcode/locality scope — the street-level tier in front of admin-centroid resolution.
 */
export interface AddressPointHit {
	lat: number
	lon: number
	/** Provenance, e.g. `"overture:NAD"`. */
	source: string
	/** Pinned data release the point came from, e.g. `"2026-05-20.0"`. */
	release: string
}

/**
 * Street-level exact-point lookup (#476). Implementations own their normalization — both the
 * shard build and this lookup must apply the SAME normalizer (see
 * `resolver-wof-sqlite/street-normalize.ts`). Core depends only on this contract.
 */
export interface AddressPointLookup {
	find(query: { street: string; number: string; postcode?: string; locality?: string }): AddressPointHit | null
}

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
	 * Default ISO-3166 alpha-2 country to constrain top-level lookups to, when no resolved parent has
	 * supplied a country yet. Without it, a bare component over a multi-country gazetteer (e.g. "IL")
	 * can fuzzy-match a foreign place. Callers should set this from the detected locale (the
	 * pipeline's locale-gate). A resolved parent's country still overrides it deeper in the tree.
	 */
	defaultCountry?: string
	/**
	 * When a resolved parent constrains a child lookup (`parentId` is passed to the backend as a hard
	 * descendant filter) and that filtered lookup returns NOTHING, retry the lookup once without the
	 * parent constraint. Guards against an incomplete gazetteer hierarchy (a real locality whose
	 * ancestor chain is missing its region) or a mis-resolved parent silently turning a resolvable
	 * node unresolved. The country constraint is retained on the retry, so resolution still can't
	 * wander cross-border. Default true. Set false to measure the strict-parent baseline.
	 */
	parentFallback?: boolean
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
	/**
	 * Optional postcode-anchor country posterior (#369) — a `{ countryCode: probability }` map
	 * derived from the address's postcode (e.g. `@mailwoman/neural`'s `extractPostcodeAnchors`). When
	 * provided, LOCALITY candidates are re-ranked by `score + anchorWeight *
	 * posterior[candidate.country]` before the top is picked, so a postcode that pins the country can
	 * pull the right-country place over a higher-BM25 foreign namesake (the "Berlin DE vs Berlin US"
	 * class the #59 anchor→resolver harness measured). OFF by default — omit it and resolution is
	 * byte-identical. Country signal only, so it touches locality lookups only; admin parents already
	 * carry country via `parentId`.
	 */
	anchorPosterior?: Record<string, number>
	/**
	 * Weight on the anchor's country posterior in the locality re-rank (#369). Default 2.0 (the value
	 * the harness swept). Only consulted when `anchorPosterior` is set.
	 */
	anchorWeight?: number
	/**
	 * Recover the dropped locality in a DUAL-ROLE-place address (#405, epic #402). Many places occupy
	 * multiple admin tiers under one name — city-states (Berlin/Hamburg/Bremen = city == state),
	 * capital-seat provinces (Milano, Madrid), UK unitary authorities — and in the
	 * international-order layout `…, Berlin, Berlin <PC>` the parser labels one token the region and
	 * drops the locality entirely, leaving a region but no locality (955/1500 Berlin rows resolved to
	 * nothing on v0.9.4).
	 *
	 * When this is on AND a region resolved AND the tree has NO locality node, the resolver consults
	 * the backend's precomputed coincident-roles relation
	 * ({@link ResolverBackend.coincidentLocalitiesFor}, #403) for a same-name coincident locality and
	 * synthesizes a node from it. The relation is the gazetteer's own structure (same name +
	 * descendant + centroid-coincidence, derived at build time), so the runtime is an O(1) membership
	 * lookup — no magic distance constant. When an admin maps to several same-name localities, the
	 * most populous wins (the principal city), nearest-centroid breaks a population tie, and a
	 * genuine tie ABSTAINS (no completion) rather than guess. The synthesized node carries
	 * `metadata.resolver_synthesized = true` (+ `relationship_type`) — it has no span in the raw
	 * input. ON by default (#402): it only fires for a dual-role region whose locality the parser
	 * dropped, and no-ops entirely when the backend has no relation (the browser WASM resolver, or a
	 * gazetteer without the `coincident_roles` table). Pass `false` to opt out.
	 */
	/**
	 * Street-level address-point tier (#476): when the tree carries `street` + `house_number`,
	 * consult this lookup and (on hit) stamp the exact point onto the street node's metadata
	 * (`address_point`, `resolution_tier: "address_point"`). Opt-in; absent = byte-stable.
	 */
	addressPoints?: AddressPointLookup
	hierarchyCompletion?: boolean
	/** @deprecated Renamed to {@link hierarchyCompletion} (#405 generalized #387). Still honored. */
	cityStateFallback?: boolean
	/**
	 * Attach each resolved node's ancestor lineage (#404) — the containment chain (county → region →
	 * country) the backend's {@link ResolverBackend.ancestors} returns — onto `metadata.ancestors`.
	 * The Pelias/Nominatim "always-attach-the-hierarchy" enrichment, so a consumer gets the full
	 * admin ladder from a single resolved place. OFF by default: omit it and resolution is
	 * byte-identical (and there's no extra query). Only attaches to nodes the resolver actually
	 * resolved.
	 */
	includeAncestors?: boolean
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
	dependent_locality: "locality",
	subregion: "county",
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
