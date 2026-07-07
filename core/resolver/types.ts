/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Resolver interface for Phase 4.3 — wires the address-component decoder to a place-id / coordinate
 *   lookup backend.
 *
 *   The interface is deliberately decoupled from any specific resolver implementation. The first
 *   shipped impl is `@mailwoman/core/resolver-wof-sqlite`, but the same contract supports a future
 *   `RemoteResolver` adapter (Phase 4.4 — Pelias / BAN / Nominatim) without a public-API break.
 *
 *   See `docs/plan/phases/PHASE_4_3_resolver_integration.md` for the design intent.
 */

import type { AddressTree, ComponentTag } from "../decoder/types.js"

/**
 * One candidate place returned by a resolver. Mirrors the shape used by `@mailwoman/core/resolver-wof-sqlite`'s
 * `PlaceCandidate` — kept structurally compatible so a callsite holding a `PlaceCandidate` can be passed where a
 * `ResolvedPlace` is expected.
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
	 * Resolver-defined ranking score. Higher = better fit for the query. Scale is implementation- defined; callers should
	 * treat as ordinal.
	 */
	score: number
	/**
	 * The candidate's PROMINENCE (see the glossary): how important this place is when breaking ties among equally-good
	 * text matches. Computed by the backend as the population term (log-scaled, capped at `populationBoost`, default 4.0)
	 * plus the best proximity-bias term (distance-decayed, capped at `biasBoost`, default 4.0). Domain [0,
	 * populationBoost + biasBoost] — typically [0, 8]; HIGHER = more prominent = ranked EARLIER within an exact-match
	 * tier. Exists because raw bm25 `score` is length-poisoned for famous places (a capital's alias-heavy index entry
	 * reads ~15 pts worse than a tiny namesake's clean one), so within-tier ordering keys on this instead; the #369
	 * anchor re-rank adds `anchorWeight × posterior[country]` on top. Optional — backends that don't compute it degrade
	 * to score-based ordering.
	 */
	prominence?: number
	/**
	 * Set by the backend when this candidate is an EXACT name/alias match for the query (vs a partial token match). The
	 * postcode-anchor re-rank (#369) uses it as the PRIMARY key so a country posterior can pin the country WITHOUT
	 * crossing the exact-match tier: "ME" under a confident US posterior stays Maine (US exact) rather than promoting the
	 * more-populous Missouri (US partial), and still beats Messina (IT exact) on the posterior WITHIN the exact tier.
	 * Absent → treated as non-exact (backends that don't tier omit it; the re-rank degrades to a plain score+posterior).
	 */
	exactMatch?: boolean
	/**
	 * Set when the resolver detected that the address's postcode and its parsed locality name point to geographically
	 * different places (a transposed / wrong-for-the-city postcode). Surfaced onto the resolved node's metadata as
	 * `postcode_city_mismatch` so callers can lower confidence or flag the conflict instead of silently mislocating.
	 */
	mismatch?: boolean
	/**
	 * Fallback-observability marker (#718). Set to `"fallback"` by the resolver when this span resolved to a
	 * placetype-EQUIVALENCE-GROUP member (a macro-type — `macroregion`/`macrocounty`) because no candidate of the EXACT
	 * requested placetype (`region`/`county`) existed. It does NOT change the resolved identity or coordinate — it only
	 * annotates that a broader admin tier stood in for the true one, so a downstream consumer / QA pass can see a
	 * macroregion was used in lieu of a region. Surfaced onto the resolved node's metadata as `resolution_quality`.
	 * Absent when the exact placetype matched (the normal case).
	 */
	resolutionQuality?: "fallback"
}

/**
 * Pull-based contract for a single resolver query. The resolver knows nothing about `AddressTree` — it just answers
 * "what place is named X, optionally constrained by Y?"
 *
 * Structurally compatible with `PlaceLookup` from `@mailwoman/core/resolver-wof-sqlite` so the latter satisfies this
 * interface without an adapter shim.
 */
export interface ResolverBackend {
	findPlace(query: {
		text: string
		placetype?: string | string[]
		country?: string
		parentID?: number | string
		/**
		 * Sibling postcode string, when the address carries one. A coordinate-first backend uses it to inject
		 * postcode-proximal locality candidates (the postcode→locality table) and soft-score them against the parsed name —
		 * recovering localities the name-match alone misses. Backends without postcode support ignore it.
		 */
		postcode?: string
		/** Proximity-bias points — a SOFT prominence re-rank; backends without support ignore it. */
		bias?: Array<{ lat: number; lon: number; weight?: number }>
		limit?: number
	}): Promise<ResolvedPlace[]>
	/**
	 * The dual-role locality (or localities) coincident with an admin place id, from the precomputed coincident-roles
	 * relation (#403). Drives {@link ResolveOpts.hierarchyCompletion}: when the parse drops the locality of a city-state /
	 * capital-seat region, the resolver completes it from here instead of re-querying. OPTIONAL — backends without the
	 * relation omit it, and completion no-ops. Synchronous: it's an in-memory map lookup once the relation is loaded.
	 */
	coincidentLocalitiesFor?(adminID: number | string): CoincidentLocality[]
	/**
	 * The ancestor lineage of a resolved place — its containment chain (county → region → country), nearest-first. Backs
	 * {@link ResolveOpts.includeAncestors} (#404): the Pelias/Nominatim "always-attach-the-hierarchy" enrichment. OPTIONAL
	 * — backends without it omit it, and the attachment is skipped. Synchronous: a memoized read of the gazetteer's
	 * `ancestors` table.
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
 * A dual-role locality returned by {@link ResolverBackend.coincidentLocalitiesFor} — a resolved place (so it can
 * decorate a node directly) plus the relation metadata the completion step disambiguates on.
 */
export interface CoincidentLocality extends ResolvedPlace {
	/**
	 * `city-state` / `capital-seat` / `consolidated-county` — surfaced as `metadata.relationship_type`.
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
 * One exact address-point hit (#476): a real situs coordinate for `(street, number)` within a postcode/locality scope —
 * the street-level tier in front of admin-centroid resolution.
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
 * Street-level exact-point lookup (#476). Implementations own their normalization — both the shard build and this
 * lookup must apply the SAME normalizer (see `resolver-wof-sqlite/street-normalize.ts`). Core depends only on this
 * contract.
 */
export interface AddressPointLookup {
	find(query: {
		street: string
		number: string
		postcode?: string
		locality?: string
		/**
		 * Optional bbox scope (`minLat`/`maxLat`/`minLon`/`maxLon`), tried AFTER postcode/locality. For shards whose points
		 * carry no postcode/locality of their own (OSM addr nodes often don't) but DO carry a coordinate — the resolved
		 * locality's bounding box scopes the `(street, number)` probe instead. US situs never passes it (byte-stable).
		 */
		bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number }
	}): AddressPointHit | null
}

/**
 * One interpolated coordinate estimate (#483) — NEVER an exact situs point (`uncertaintyM` prices the estimate
 * honestly). Structural mirror of `InterpolatedHit` in `resolver-wof-sqlite/interpolation.ts`; keep this a SUBSET of
 * that shape so the concrete `StreetInterpolator`/`AddressPointInterpolator` satisfy {@link InterpolationLookup} with no
 * adapter (the {@link AddressPointHit} precedent).
 */
export interface InterpolatedPointHit {
	lat: number
	lon: number
	interpolated: true
	/**
	 * `address_point` = bracketed between real neighbor points; `tiger_range` = linear within a segment range.
	 */
	method: "address_point" | "tiger_range"
	/** False when only the opposite side's range contained the number (right block, wrong side). */
	parityMatched?: boolean
	/** `both` = neighbors bracketed it; `single` = one-sided extrapolation (larger uncertainty). */
	bracket?: "both" | "single"
	/** Honest uncertainty radius in METERS (half the matched segment length). */
	uncertaintyM: number
	source: string
	release: string
}

/**
 * House-number interpolation lookup (#483). Like {@link AddressPointLookup}, implementations own their normalization
 * (the shared `resolver-wof-sqlite/street-normalize.ts`); core depends only on this contract. Postcode-scoped (no
 * locality field) — the tier abstains statewide without a postcode.
 */
export interface InterpolationLookup {
	find(query: { street: string; number: string; postcode?: string }): InterpolatedPointHit | null
}

export interface ResolveOpts {
	/**
	 * Hard cap on how many backend lookups one tree may issue. Default 10. Prevents a tree with dozens of candidate nodes
	 * from triggering dozens of queries.
	 */
	maxLookups?: number
	/**
	 * Minimum candidate score before resolver attribution wins over the classifier's. Default 0. A higher threshold makes
	 * the resolver more conservative — it leaves more nodes with classifier provenance. Score scale is
	 * implementation-defined; tune per backend.
	 */
	minWinningScore?: number
	/**
	 * Maximum candidates to request from the backend per lookup. Default 5 — we only use the top candidate after
	 * post-scoring, but the backend may benefit from over-fetching for ranking.
	 */
	candidatesPerLookup?: number
	/**
	 * Default ISO-3166 alpha-2 country to constrain top-level lookups to, when no resolved parent has supplied a country
	 * yet. Without it, a bare component over a multi-country gazetteer (e.g. "IL") can fuzzy-match a foreign place.
	 * Callers should set this from the detected locale (the pipeline's locale-gate). A resolved parent's country still
	 * overrides it deeper in the tree.
	 */
	defaultCountry?: string
	/**
	 * Ordered proximity-bias points (viewport center first, then user location, …), each optionally weighted (default
	 * 1.0). SOFT ranking signal only — candidates near a bias point win prominence ties (the ambiguous-postcode case:
	 * "48026" follows the map view to Michigan or Italy); recall and filters are untouched, and omitting it keeps ranking
	 * byte-identical. Callers: the CLI's `--bias lat,lon[:weight]`, the demo's viewport/user hints, `GeocodeDeps.bias`.
	 */
	bias?: Array<{ lat: number; lon: number; weight?: number }>
	/**
	 * When a resolved parent constrains a child lookup (`parentID` is passed to the backend as a hard descendant filter)
	 * and that filtered lookup returns NOTHING, retry the lookup once without the parent constraint. Guards against an
	 * incomplete gazetteer hierarchy (a real locality whose ancestor chain is missing its region) or a mis-resolved
	 * parent silently turning a resolvable node unresolved. The country constraint is retained on the retry, so
	 * resolution still can't wander cross-border. Default true. Set false to measure the strict-parent baseline.
	 */
	parentFallback?: boolean
	/**
	 * Override the default ComponentTag → resolver-placetype mapping. When set, this map FULLY REPLACES
	 * `DEFAULT_PLACETYPE_MAP` — start from the default by spreading it (`{ ...DEFAULT_PLACETYPE_MAP, ... }`) if you want
	 * to extend rather than replace. The fully- replacing semantics let callers narrow the resolver scope (e.g. drop
	 * `locality` if the backend doesn't ship locality data for the current locale) without awkward `undefined`-as-delete
	 * tricks.
	 */
	placetypeMap?: PlacetypeMap
	/**
	 * Optional locale hint. Currently unused by the v1 resolver but reserved so the contract doesn't break when
	 * locale-aware resolvers land in 4.4+.
	 */
	locale?: string
	/**
	 * Optional postcode-anchor country posterior (#369) — a `{ countryCode: probability }` map derived from the address's
	 * postcode (e.g. `@mailwoman/neural`'s `extractPostcodeAnchors`). When provided, LOCALITY candidates are re-ranked by
	 * `score + anchorWeight * posterior[candidate.country]` before the top is picked, so a postcode that pins the country
	 * can pull the right-country place over a higher-BM25 foreign namesake (the "Berlin DE vs Berlin US" class the #59
	 * anchor→resolver harness measured). OFF by default — omit it and resolution is byte-identical. Country signal only,
	 * so it touches locality lookups only; admin parents already carry country via `parentID`.
	 */
	anchorPosterior?: Record<string, number>
	/**
	 * Weight on the anchor's country posterior in the locality re-rank (#369). Default 2.0 (the value the harness swept).
	 * Only consulted when `anchorPosterior` is set.
	 */
	anchorWeight?: number
	/**
	 * #743/#194 — a CONFIDENT coarse-placer country applied as a HARD candidate filter (`query.country`), not the soft
	 * {@link anchorPosterior} boost. This collapses the off-continent tail for LOW-population places the soft prior can't
	 * move (FI/PL — their towns lose to a high-pop namesake in the population-first gazetteer even when the country is
	 * pinned). On a miss the node is left UNRESOLVED ("in-region or unresolved") rather than re-resolved globally — the
	 * off-continent rows are precisely the ones whose locality isn't in the country's gazetteer slice, so a global
	 * fallback just re-admits the wrong-continent guess (measured: it collapses back to the soft-prior baseline). The win
	 * is coverage-bounded: tail collapse at a recall cost set by how complete the country's gazetteer is (PL −9.5pp, FI
	 * −32pp). Undefined (default) → byte-stable. Ignored when a resolved parent or {@link defaultCountry} already pins
	 * the country.
	 */
	hardCountry?: string
	/**
	 * Recover the dropped locality in a DUAL-ROLE-place address (#405, epic #402). Many places occupy multiple admin
	 * tiers under one name — city-states (Berlin/Hamburg/Bremen = city == state), capital-seat provinces (Milano,
	 * Madrid), UK unitary authorities — and in the international-order layout `…, Berlin, Berlin <PC>` the parser labels
	 * one token the region and drops the locality entirely, leaving a region but no locality (955/1500 Berlin rows
	 * resolved to nothing on v0.9.4).
	 *
	 * When this is on AND a region resolved AND the tree has NO locality node, the resolver consults the backend's
	 * precomputed coincident-roles relation ({@link ResolverBackend.coincidentLocalitiesFor}, #403) for a same-name
	 * coincident locality and synthesizes a node from it. The relation is the gazetteer's own structure (same name +
	 * descendant + centroid-coincidence, derived at build time), so the runtime is an O(1) membership lookup — no magic
	 * distance constant. When an admin maps to several same-name localities, the most populous wins (the principal city),
	 * nearest-centroid breaks a population tie, and a genuine tie ABSTAINS (no completion) rather than guess. The
	 * synthesized node carries `metadata.resolver_synthesized = true` (+ `relationship_type`) — it has no span in the raw
	 * input. ON by default (#402): it only fires for a dual-role region whose locality the parser dropped, and no-ops
	 * entirely when the backend has no relation (the browser WASM resolver, or a gazetteer without the `coincident_roles`
	 * table). Pass `false` to opt out.
	 */
	/**
	 * Street-level address-point tier (#476): when the tree carries `street` + `house_number`, consult this lookup and
	 * (on hit) stamp the exact point onto the street node's metadata (`address_point`, `resolution_tier:
	 * "address_point"`). Opt-in; absent = byte-stable.
	 */
	addressPoints?: AddressPointLookup
	/**
	 * Pass the resolved locality's BBOX to the address-point lookup as a final scope (#247). For shards whose points
	 * carry no postcode/locality of their own (OSM addr nodes often don't), the postcode/locality probes miss and the
	 * lookup falls through to a `(street, number)` probe within the box. OFF by default — US situs never sets it, so the
	 * bbox arg is simply never supplied and its postcode/locality probes are byte-identical.
	 */
	addressPointBboxFallback?: boolean
	/**
	 * House-number interpolation tier (#483): consulted ONLY when the exact address-point tier ({@link addressPoints})
	 * did NOT stamp the street node — the "after the exact-point fall-through" semantics. On hit, stamps the estimate
	 * onto the street node's metadata under a DISTINCT key (`interpolated_point`, `resolution_tier: "interpolated"`,
	 * `uncertainty_m`) — never `address_point`, so a consumer reading the exact key never gets an estimate mislabeled as
	 * exact. Opt-in; absent = byte-stable. Independent of {@link addressPoints} (either, both, or neither may be
	 * passed).
	 */
	interpolation?: InterpolationLookup
	/**
	 * Conformal calibration multiplier for the interpolation tier's `uncertainty_m` (#374). The raw radius is half the
	 * matched TIGER segment length — an honest-but-TIGHT prior: a split-conformal calibration on 1562 Travis-County
	 * interp hits (2026-06-14) found it covers only ~72% of true errors, and that multiplying by **Q̂ ≈ 1.70** yields a
	 * calibrated 90% bound (91.5% empirical). When set, `applyInterpolation` reports `uncertainty_m = round(raw × this)`
	 * and preserves the raw value under `uncertainty_raw_m`. Absent = raw heuristic (byte-stable). The factor is the
	 * CALLER's (it's a property of the calibration set, not the geometry); the geocode CLI passes the TX-derived 1.70.
	 * Re-calibrate on a multi-region holdout before treating it as national-exact. Report:
	 * docs/articles/evals/2026-06-14-interp-radius-calibration.md.
	 */
	interpolationRadiusCalibration?: number
	/**
	 * Span-rescore tier (#370). When the tree resolved nothing, recover a dropped/fragmented locality from the raw text:
	 * enumerate raw-token spans, exact-match the same-country gazetteer (longest-wins + postcode-consistency gate), and
	 * inject the recovered locality as a resolved node. Targets the EU no-result tail the model leaves when it fragments
	 * an accented locality token ("Grudziądz" → "Grudzi"+"dz", #555). **Default-ON** (promoted 2026-06-25 — same-harness
	 * EU+AU +1pp @25km, zero regressions); set `false` to opt out (byte-stable then). Never disturbs a tree that already
	 * resolved (the #685 brake). Validated in `docs/articles/evals/2026-06-23-370-span-rescore.mdx` +
	 * `2026-06-25-eu-competitive-standing.md`.
	 */
	spanRescore?: boolean
	/**
	 * Postcode-consistency gate radius (km) for the span-rescore tier — reject a recovered locality farther than this
	 * from where the postcode resolves. Only bites when the backend has postcode coverage (else no anchor, no gate).
	 * Default 50.
	 */
	spanRescoreGateKm?: number
	/**
	 * Postal-compound recovery inside the span-rescore tier (#942). The knife-edge no-street query shape ("Kožljek 7,
	 * 1382 Kožljek") fails as a COMPOUND: the parse globs the trailing city into the postcode span ("1382 Kožljek"),
	 * which then (a) resolves as neither postcode nor locality and (b) BLOCKS its own city tokens from span-rescore's
	 * recovery (a confident postcode span is avoided). Proven training-composition-insensitive on #901 — five vehicles
	 * including a full from-scratch retrain all tip this class, so the floor lives here, model-independently.
	 *
	 * When on and the tree resolved nothing: the failed postcode span only blocks its CODE-shaped tokens (digit-bearing;
	 * the residual city tokens become recoverable), the postcode-consistency anchor retries with that code subset, and
	 * the failed postcode NODE is decorated from the code resolution (a postcode-tier coordinate floor, strictly
	 * subordinate to a recovered locality). Never fires on a resolved tree (the #685 brake).
	 *
	 * **Default ON** (operator-promoted 2026-07-03 after the pre-registered gate: SI 25/25 recovery at p50 0.67 km, US/FR
	 * byte-identical, and the insurance leg — the composition-failed v2.2.0 candidate recovers all 55 lost rows). Set
	 * `false` to opt out (byte-stable then).
	 */
	postalCompoundRecovery?: boolean
	/**
	 * Postcode-disambiguated locality selection (#370 "Lever A"). When set, AND a locality resolves far from a resolved
	 * sibling postcode, re-pick the same-named candidate (from the lookup's already- captured `alternatives`) nearest the
	 * postcode; if none reconciles within the gate, fall the coordinate back to the postcode point and flag
	 * `postcode_city_mismatch`. Targets the dominant failure mode on the EU/AU panel — a same-named town resolved to the
	 * wrong instance while the postcode that would disambiguate it sits resolved in the same tree (e.g. "06260
	 * Saint-Pierre" → 617 km off, postcode 06260 correct). Only bites where the backend resolved the postcode to a point
	 * (so it composes with postcode coverage, #193).
	 *
	 * **Default ON** (operator-promoted 2026-07-04 after the corrected gate: FI 231 wins / 0 losses, SI 37/6, CZ 47/2, US
	 * aggregates byte-flat with 9/2,000 rows touched — the four losses being two golden-data errors the pass correctly
	 * flags as `postcode_city_mismatch` and one bad ZIP centroid). Explicit `false` opts out (byte-stable then).
	 */
	postcodeConsistency?: boolean
	/**
	 * Gate radius (km) for {@link postcodeConsistency} — a locality farther than this from the resolved postcode is
	 * re-picked or demoted. Default 50.
	 */
	postcodeConsistencyGateKm?: number
	/**
	 * Admin descendant-consistency (#263). When a region resolved but its child locality did NOT — the greedy region pick
	 * (name + population) chose a foreign namesake whose descendants hold no such locality ("Portland, ME" → Messina IT;
	 * "Portland" then finds nothing beneath it and falls back to the region centroid) — re-pick the (region, locality)
	 * pair JOINTLY against the gazetteer's containment graph: the best same-named locality that descends from one of the
	 * region's same-named candidates. "Portland" descends from Maine, not Messina, so the pair resolves to (Maine,
	 * Portland-Maine). Generalizes to every country with no country prior and no list. Costs ONE unscoped locality lookup
	 * per triggering admin pair; only fires where a locality fell through, so the well-resolved path is byte-identical.
	 * Needs {@link ResolverBackend.ancestors}; no-op without it. **Default-ON** (#895 settled drift D1 — the geocode path
	 * had run it since #837 while raw `resolveTree` callers silently didn't); byte-stable wherever nothing fell through
	 * or the backend lacks `ancestors`. Pass `false` to opt out.
	 */
	adminCoherence?: boolean
	hierarchyCompletion?: boolean
	/** @deprecated Renamed to {@link hierarchyCompletion} (#405 generalized #387). Still honored. */
	cityStateFallback?: boolean
	/**
	 * Attach each resolved node's ancestor lineage (#404) — the containment chain (county → region → country) the
	 * backend's {@link ResolverBackend.ancestors} returns — onto `metadata.ancestors`. The Pelias/Nominatim
	 * "always-attach-the-hierarchy" enrichment, so a consumer gets the full admin ladder from a single resolved place.
	 * OFF by default: omit it and resolution is byte-identical (and there's no extra query). Only attaches to nodes the
	 * resolver actually resolved.
	 */
	includeAncestors?: boolean
}

/**
 * Mapping from mailwoman's address-component tags to the resolver's placetype taxonomy. Components not present in the
 * map are NOT queried — the resolver pass leaves their classifier attribution untouched.
 *
 * Phase 4.3 default ships the obvious admin-level mappings; other tags (postcode, street, venue, dependent_locality,
 * prefecture, etc.) are explicitly omitted because:
 *
 * - `postcode` lives in a separate WOF shard (Phase 4.3.x follow-up via the postalcode loader).
 * - `street` / `house_number` aren't in WOF admin — would need OSM / OpenAddresses gazetteers and license diligence
 *   (Phase 4.4 candidate).
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
	// backend has the postcode shard available — `WOFSqlitePlaceLookup` auto-routes `postalcode`
	// queries to a `postalcode_us` (or similarly-named) shard, falling back to main if absent.
	postcode: "postalcode",
}

/**
 * Placetype-equivalence groups for lookup FILTERING. WOF splits a single addressing tier across several placetypes, but
 * an address's span can name ANY of them. A backend that filters to the one "obvious" placetype makes the equivalents
 * unreachable, so a fuzzy same-name place in the wrong tier wins instead.
 *
 * Three tiers are affected (the value of each entry is the set the SQL filter should accept; the FIRST entry is the
 * canonical/requested type, which shard routing keys off):
 *
 * - **`locality`** — `locality` (most cities), `borough` (Brooklyn, the Paris arrondissements, the London boroughs), and
 *   `localadmin` (FR communes, US towns/townships in New England). Without the group, Brooklyn-the-borough (pop 2.5M)
 *   was unreachable and the fuzzy "Brooklyn Park, MN" won.
 * - **`region`** — `region` + `macroregion` (#718). WOF does NOT model every country's top-level civil division as
 *   `region`: Italian regions (Lombardia, Veneto, Toscana…) are `macroregion` (their PROVINCES are `region`), and the
 *   post-2016 French régions (Île-de-France) are `macroregion` too. An address's `region` span names exactly those, so
 *   a `region`-only filter resolved them to NOTHING (confirmed against the IT/FR eval rows). US states / DE
 *   Bundesländer / ES provincias are genuine `region`, so the EXACT-type match is preferred in ranking (see the
 *   resolve.ts fallback-quality annotation) — the macro is the recall safety net, not a demotion.
 * - **`county`** — `county` + `macrocounty` (#718). The `subregion` ComponentTag maps to `county` via
 *   {@link DEFAULT_PLACETYPE_MAP}; WOF carries `macrocounty` for FR départements-grouping / DE / GB tiers above the
 *   county. Proactive (no eval row exercises `subregion` today) but symmetric with `region` — biasing to inclusion,
 *   since a missed resolution costs more than a too-broad candidate (which is QA-visible). Same exact-type preference
 *   applies.
 *
 * This table is the single source of truth for that expansion, shared by every lookup backend
 * (`@mailwoman/core/resolver-wof-sqlite`, `@mailwoman/core/resolver-wof-wasm`, and the demo's httpvfs lookup) so the
 * Node and browser resolvers can't drift. Keyed by the REQUESTED placetype. Placetypes without an entry pass through
 * unchanged — an explicit `placetype: "borough"` query stays narrow.
 */
export const PLACETYPE_FILTER_GROUPS: Readonly<Record<string, readonly string[]>> = {
	locality: ["locality", "borough", "localadmin"],
	region: ["region", "macroregion"],
	county: ["county", "macrocounty"],
}

/**
 * Expand a placetype filter through {@link PLACETYPE_FILTER_GROUPS}, deduplicated and order-preserving (the first entry
 * stays first — shard routing keys off it). `null`/`undefined` (no filter) passes through untouched.
 */
export function expandPlacetypeFilter(placetypes: null): null
export function expandPlacetypeFilter(placetypes: readonly string[]): string[]
export function expandPlacetypeFilter(placetypes: readonly string[] | null): string[] | null
export function expandPlacetypeFilter(placetypes: readonly string[] | null): string[] | null {
	if (!placetypes) return null
	const out: string[] = []

	for (const placetype of placetypes) {
		for (const expanded of PLACETYPE_FILTER_GROUPS[placetype] ?? [placetype]) {
			if (!out.includes(expanded)) {
				out.push(expanded)
			}
		}
	}

	return out
}

/**
 * Macro/broader-tier members of {@link PLACETYPE_FILTER_GROUPS} — the recall safety net a query may fall through to
 * when no candidate of the EXACT requested placetype exists (#718). DELIBERATELY scoped to the `macro*` tiers only: the
 * `locality` group's `borough`/`localadmin` are genuine peers (Brooklyn-the-borough is a first-class locality answer,
 * #404-class), NOT fallbacks — so they must NOT be deprioritized or annotated. Only `macroregion`/`macrocounty` are a
 * broader admin tier standing in for a true `region`/`county`.
 */
const MACRO_FALLBACK_PLACETYPES: ReadonlySet<string> = new Set(["macroregion", "macrocounty"])

/**
 * Did `candidatePlacetype` resolve `requestedPlacetype` only via a BROADER admin tier (a macro-type fallback within the
 * {@link PLACETYPE_FILTER_GROUPS} expansion), rather than the exact type (#718)?
 *
 * `region` → `region` is exact (false); `region` → `macroregion` is a fallback (true). Scoped to the `macro*` tiers
 * (see {@link MACRO_FALLBACK_PLACETYPES}) so the `locality` group's borough/localadmin peers stay exact. The resolver
 * uses this to (a) prefer an exact-type candidate in ranking and (b) annotate `resolutionQuality: "fallback"` when only
 * a macro-type matched. A placetype outside the requested group, or any non-macro member, is treated as exact (false).
 */
export function isPlacetypeFallback(requestedPlacetype: string, candidatePlacetype: string): boolean {
	const group = PLACETYPE_FILTER_GROUPS[requestedPlacetype]

	if (!group) return false

	if (candidatePlacetype === requestedPlacetype) return false

	return MACRO_FALLBACK_PLACETYPES.has(candidatePlacetype) && group.includes(candidatePlacetype)
}

/**
 * The interface implemented by `createWOFResolver` and any future resolver factories.
 *
 * `resolveTree` returns a NEW `AddressTree` rather than mutating — keeps the input safe to inspect after the call. The
 * new tree's `roots` are fresh `AddressNode` objects; nodes the resolver didn't touch are structurally cloned with
 * their classifier attribution preserved.
 */
export interface Resolver {
	resolveTree(tree: AddressTree, opts?: ResolveOpts): Promise<AddressTree>
}
