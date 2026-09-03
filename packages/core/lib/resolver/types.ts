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
 *
 *   This module is a published subpath (`@mailwoman/core/resolver/types`) with a wide consumer set, so the
 *   groups that moved to siblings are re-exported here rather than requiring every importer to move with them.
 */

import type { AddressTree } from "#decoder/types"
import type { GazetteerArtifactCoverage } from "#resolver/coverage-facts"
import type {
	AddressPointLookup,
	InterpolationLookup,
	PostcodePrefixIndexLike,
	StreetCentroidLookup,
} from "#resolver/lookup-types"
import type { PlacetypeMap } from "#resolver/placetype-map"

export type { CountryBBoxFact, CountryCoverageFact, GazetteerArtifactCoverage } from "#resolver/coverage-facts"
export { hardCountrySafelistFromCoverage } from "#resolver/coverage-facts"

export type {
	AddressPointHit,
	AddressPointLookup,
	InterpolatedPointHit,
	InterpolationLookup,
	PostcodePrefixAncestor,
	PostcodePrefixIndexLike,
	PostcodePrefixNode,
	StreetCentroidHit,
	StreetCentroidLookup,
} from "#resolver/lookup-types"

export {
	DEFAULT_PLACETYPE_MAP,
	expandPlacetypeFilter,
	isPlacetypeFallback,
	PLACETYPE_FILTER_GROUPS,
	type PlacetypeMap,
} from "#resolver/placetype-map"

/**
 * One candidate place returned by a resolver. Mirrors the shape used by `@mailwoman/core/resolver-wof-sqlite`'s
 * `PlaceCandidate` — kept structurally compatible so a callsite holding a `PlaceCandidate` can be passed where a
 * `ResolvedPlace` is expected.
 */
export interface ResolvedPlace {
	/**
	 * Resolver-specific place identifier (e.g. WOF id).
	 */
	id: number | string
	/**
	 * Canonical name of the place as the resolver knows it.
	 */
	name: string
	/**
	 * Resolver's placetype taxonomy label (e.g. WOF's `country` / `region` / `locality`).
	 */
	placetype: string
	/**
	 * ISO 3166-1 alpha-2 country code, if known.
	 *
	 * Optional because "if known" is literal: a candidate can carry no country, and `rankByImportance` has a branch for
	 * it. The type said `string` while that branch existed, so the test proving the branch had to assert past the
	 * signature.
	 */
	country?: string
	/**
	 * Centroid latitude in WGS-84 decimal degrees.
	 */
	lat: number
	/**
	 * Centroid longitude in WGS-84 decimal degrees.
	 */
	lon: number
	/**
	 * Parent place id within the resolver's hierarchy, if any.
	 */
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
	 * Raw population from the backend's record, when carried (`PlaceCandidate.population` mirrors it). Absent means
	 * UNKNOWN, never zero — the meaning-of-zero rule. The bare-toponym race's region-dominance rule reads this because
	 * {@link ResolvedPlace.prominence} saturates at the backend's population cap and erases the margins it needs.
	 */
	population?: number
	/**
	 * REFERENTIAL likelihood in [0, 1] — population-anchored, the named form of the key namesake ranking has always used
	 * (ROAD_TO_V9 §2, ratified 2026-08-06: "the importance of a knowledge-base article is not the probability that this
	 * is the place the user means"). Absent when the backend has no population for the place.
	 */
	referential?: number
	/**
	 * STRICT encyclopedia-evidence importance in [0, 1] — CARRIED FOR CONSUMERS, NEVER RANKED ON.
	 *
	 * RESERVED SLOT: it awaits a strict-channel source. Only a backend reading a post-split `place_importance` table can
	 * populate it, and today the FTS backend's clauses emit NULL for everything (no shipped admin DB carries the split
	 * columns), so nothing produces it and nothing consumes it. The BLENDED prior the ranking reads is
	 * {@link ResolvedPlace.importance} — keep the two apart.
	 *
	 * Ranking on this channel is forbidden even once populated. The canonical reason is Saint-Denis: the
	 * Seine-Saint-Denis suburb (pop 96,128) scores 0.1173 while the Aude hamlet (pop 418) scores 0.5683, so ranking on it
	 * inverts the answer every user means.
	 *
	 * Absent means "no encyclopedia entry" OR "this gazetteer predates the two-score split" — both absence, neither 0.
	 */
	encyclopedic?: number
	/**
	 * BLENDED global toponym prior in [0, 1] (#28) — the fame key the bare-toponym class is decided on.
	 *
	 * The value is the score source's legacy blended importance: the concordance's encyclopedia-derived channel where a
	 * concordance matched, a population-derived proxy everywhere else. The blend is deliberate — it is the only scale on
	 * which EVERY bearer of a name is scored comparably (the strict channel reaches eleven countries and is blind on
	 * CA/AU/RU, exactly the homonym contests the prior exists to settle; see `candidate-schema.ts` →
	 * `CandidateTable.importance`). Consumed by `rankByImportance` (`resolver/toponym-prior.ts`), a soft tier-safe
	 * re-rank, never a filter.
	 *
	 * Absent means UNMEASURED — the score source had no row, the join refused it, or the artifact predates the column —
	 * and an unmeasured candidate holds the rank population gave it (meaning-of-zero: never fill a 0 in).
	 */
	importance?: number
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
	/**
	 * The admin-containment verdict for this candidate (#1717 stage 2) — TRI-STATE, and the absence is required
	 * (meaning-of-zero): `true` = the backend's ancestors sidecar vouches that this candidate sits UNDER the query's
	 * parsed region qualifier; `false` = the backend evaluated containment and could not vouch for it; `undefined` = the
	 * question was never asked — the setting is off, the query carried no qualifier, or the backend/artifact cannot
	 * answer (no sidecar). Set only by backends implementing `FindPlaceQuery.regionQualifier`; consumed by the resolver
	 * walk's `adminContainmentRerank` partition, which must never read `undefined` as "not contained".
	 */
	containedByQualifier?: boolean
	/**
	 * #1731: `true` when a `parentID` region scope was applied, MISSED across the whole probe cascade, and the backend's
	 * unscoped fallback produced this row — the re-admission path where a wrong-instance namesake enters (the Astoria
	 * class: no locality-group row exists under the parent, so the fallback answers population-first from anywhere).
	 * Absent when the question never arose (no parent scope, or the scoped probe answered). Backend-optional; the
	 * resolver-interior trace (#1721) surfaces it as a check.
	 */
	regionScopeMiss?: boolean
	/**
	 * The #1882 variant-alias exemption's firing mark (#1893): this candidate's row would have taken the cross-country
	 * alias penalty and the exemption prevented it. PRESENT only when the exemption changed the row's treatment; absent
	 * everywhere else — including on backends that never run the primary-preference ranker (the WASM FTS lookup), where
	 * absence means the mechanism was not evaluated, never that it declined to fire.
	 */
	variantAliasExempted?: true
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
		/**
		 * ISO-3166 alpha-2 scoping the TYPO-FUZZY tier only (#1585): exact and qualifier-strip probes stay worldwide, the
		 * corrected-key probes honor it, and a scoped-empty fuzzy ABSTAINS instead of falling through to a world-fuzzy
		 * candidate. Backends without a fuzzy tier ignore it. Ignored when `country` is set (already narrower).
		 */
		fuzzyCountry?: string
		parentID?: number | string
		/**
		 * Sibling postcode string, when the address carries one. A coordinate-first backend uses it to inject
		 * postcode-proximal locality candidates (the postcode→locality table) and soft-score them against the parsed name —
		 * recovering localities the name-match alone misses. Backends without postcode support ignore it.
		 */
		postcode?: string
		/**
		 * Postcode-containment coherence (#31, Mechanism 2) — when set, a coordinate-first backend may re-rank locality
		 * candidates by distance to the sibling postcode's own centroid (bounded by a 25 km containment check) instead of
		 * answering blind population-first. Opt-in, strictly beneath the #741 exact `(name_key, postcode)` probe; backends
		 * without postcode support ignore it.
		 */
		postcodeContainmentCoherence?: boolean
		/**
		 * Proximity-bias points — a SOFT prominence re-rank; backends without support ignore it.
		 */
		bias?: Array<{ lat: number; lon: number; weight?: number }>
		/**
		 * Restrict name matching to PRIMARY-keyed rows — set by probes whose query surface is a RE-READING (a token taken
		 * out of a longer classified span) rather than a naming. The #1626 rationale, generalized: `Savile Row`'s token
		 * `Row` never named Rhu's historical alias, so the alias tier must not answer it; a whole-input bare toponym DID
		 * name whatever it matches (Москва's exonym rows included) and keeps the alias tier. Backends without a primary
		 * flag ignore it.
		 */
		primaryOnly?: boolean
		/**
		 * Alias-row NAME ROLES the probe refuses to answer through (#1730) — set by the bare-toponym side races with
		 * `abbr`/`gloss`. A lone bare token matching only an abbreviation row ("Tó" folded onto Toledo's "TO") or a
		 * translation-gloss row is a weak re-reading, not a naming; role-NULL alias rows (the exonym tier, the country
		 * display names) stay fully open, which is what `primaryOnly` could never express. Backends without a role column
		 * ignore it — an older artifact degrades to today's behavior.
		 */
		excludeNameRoles?: readonly string[]
		/**
		 * The tree's parsed REGION qualifier, verbatim (#1717 stage 2) — set by the resolver on locality lookups when
		 * `ResolveOpts.adminContainmentRerank` is on. A capable backend resolves the qualifier to its own region-class rows
		 * and (a) stamps every returned candidate's `containedByQualifier`, (b) ranks contained candidates ahead of
		 * uncontained ones, and (c) may ADD contained same-name candidates its other filters (a locale-inferred country
		 * scope) would have hidden — additive only, never a filter, so a qualifier that matches nothing changes nothing.
		 * Backends without a containment source ignore it (candidates then carry no stamp, which the walk reports as
		 * `unavailable`).
		 */
		regionQualifier?: string
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
	/**
	 * Facts the loaded gazetteer artifact declares about itself (its coverage-manifest tables, read at open). OPTIONAL —
	 * absent when the artifact predates the manifest, and consumers fall back to the code constants.
	 */
	artifactCoverage?: GazetteerArtifactCoverage
}

/**
 * An optional {@link ResolverBackend} method the loaded backend does not implement, and what that costs.
 *
 * Optional methods let a backend be valid while omitting a capability — but the options they serve can still default to
 * ON, in which case the feature reports success and does nothing. This type carries the absence as data so a caller can
 * read it instead of inferring it from a result that looks complete.
 */
export interface BackendCapabilityGap {
	/**
	 * The absent method, named as it appears on {@link ResolverBackend}.
	 */
	capability: "ancestors" | "coincidentLocalitiesFor"
	/**
	 * The {@link ResolveOpts} field whose behavior the absence removes.
	 */
	option: keyof ResolveOpts
	/**
	 * Whether `option` is on unless a caller turns it off — the difference between a silent loss and a chosen one.
	 */
	defaultOn: boolean
	/**
	 * What stops working, in terms of the answer rather than the call.
	 */
	degrades: string
	/**
	 * The backend's class name, so a log line identifies which artifact is loaded.
	 */
	backend: string
}

/**
 * One link in a resolved place's containment lineage ({@link ResolverBackend.ancestors}, #404).
 */
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
	/**
	 * Locality population (0 when unknown) — the PRIMARY disambiguator when an admin has several.
	 */
	population: number
	/**
	 * Centroid distance (km) admin↔locality from the relation — the population tiebreak.
	 */
	distanceKm: number
}

/**
 * Options for `resolveTree`. All optional with sensible defaults.
 */

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
	 * Callers should set this from the detected locale (the pipeline's locale-hint). A resolved parent's country still
	 * overrides it deeper in the tree.
	 */
	defaultCountry?: string
	/**
	 * True when {@link defaultCountry} was INFERRED from the locale rather than user-declared. A `country`-placetype
	 * lookup under an inferred scope is a self-contradiction — the query names a country outright, and the filter can
	 * only admit the scope country itself (bare `Germany` under the default en-US locale filtered out the DE row and fell
	 * through to a US locality whose historical alias is "Germany, Ohio"). The resolver therefore withholds an inferred
	 * {@link defaultCountry} from `country`-placetype lookups only; an EXPLICIT scope stays supreme (the #912 posture), as
	 * do parent evidence and the confident placer.
	 */
	defaultCountryIsInferred?: boolean
	/**
	 * #1585 — the locale hint's country, scoping the backend's TYPO-FUZZY tier only. Unlike {@link defaultCountry} this
	 * is threaded even where the bare-toponym guard withholds the hard scope: an exact foreign match still resolves
	 * (`Paris` under en-US), but a typo CORRECTION stays inside the hinted country, and a scoped-empty correction
	 * abstains rather than falling through to a world-fuzzy candidate (`Stanmore Bay` under en-NZ must not answer Banmore
	 * IN). Never a country filter on exact matches — the fuzzy tier is the only consumer.
	 */
	fuzzyCountryScope?: string
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
	 * #27 — the LOCALE's country as a SOFT ranking prior on the admin walk, for the one query shape that has no other
	 * country signal: a bare toponym.
	 *
	 * `--locale en-GB "Whitby"` and `--default-country GB "Whitby"` should not disagree, and they do: the second is gold
	 * and the first answers Whitby, Ontario, 5,508 km away. The #912 guard in the CLI is why — it drops the
	 * locale-inferred country entirely for a bare-locality tree, because as a HARD filter that country is a disaster
	 * (`--locale en-US "Zürich"` hard-scoped to US returns Zurich, Kansas, population 81). Dropping it is the right call
	 * for a filter and the wrong call for a prior, and this field is the third option: `rankByCountryPrior`
	 * (`resolver/toponym-prior.ts`) adds {@link localeCountryPriorWeight} to an in-country candidate's prominence, within
	 * the exact tier, never as a filter.
	 *
	 * **Undefined by default, and the CLI leaves it undefined** — this is an OPT-IN change (`--locale-country-prior`),
	 * not a shipped default, and the reason is measured rather than cautious. In log10-population units the weight needed
	 * to flip the four bare GB panel rows is ≥ 0.99 (Whitby CA 5.11 over GB 4.12), and the weight that leaves the en-US
	 * board intact is < 0.07 (Cambridge CA 5.14 over US 5.07). The two intervals are disjoint, and they interleave:
	 * `Athens` (GR over US, gap 0.38) and `Cambridge` (0.07) sit BELOW `Warwick` (0.41) and `Epping` (0.41), so no
	 * threshold, margin or rank rule separates the class either. Population plus a locale cannot answer this question.
	 * The key that can is `importance` — the blended global toponym prior, which ranks all four the right way round and
	 * whose consumer (`rankByImportance`) is already wired here; the #28 candidate build produces it. See
	 * `scratchpad/resolver-plumbing-receipt-2026-08-10.md`.
	 *
	 * Ignored whenever a {@link defaultCountry} or an {@link anchorPosterior} is in force: a hard scope makes the prior a
	 * no-op by construction, and a posterior derived from the address's own postcode is EVIDENCE, which outranks a guess
	 * about where the user is sitting.
	 */
	localeCountryPrior?: string
	/**
	 * Weight of {@link localeCountryPrior}, in log10(population + 1) — the candidate backend's own `prominence` scale.
	 * Default `DEFAULT_COUNTRY_PRIOR_WEIGHT` (2): "the in-country place may be up to 100x smaller and still win". Only
	 * consulted when `localeCountryPrior` is set.
	 */
	localeCountryPriorWeight?: number
	/**
	 * #1880 — capital status of a candidate (2 national capital, 1 admin-1 seat, 0 neither), answered by the caller's
	 * reference against the candidate's own name + country + coordinates. Consumed by the resolver's bounded capital
	 * promotion (`resolver/toponym-prior.ts` — the bare-toponym class only, after the fame key). Structural rather than a
	 * named import because this package must not depend on the reference's home. Undefined → no promotion, byte-stable.
	 */
	capitalLevel?: (place: { name: string; country?: string; lat: number; lon: number }) => number
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
	 * Pass the resolved locality's BBOX to the address-point lookup as a final scope (#247). For extracts whose points
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
	 * Conformal calibration multiplier OVERRIDE for the interpolation tier's `uncertainty_m` (#374). The raw radius is
	 * half the matched TIGER segment length — an honest-but-TIGHT prior: a split-conformal calibration on 1562
	 * Travis-County interp hits (2026-06-14) found it covers only ~72% of true errors, and that multiplying by **Q̂ ≈
	 * 1.70** yields a calibrated 90% bound (91.5% empirical). When a factor applies, `applyInterpolation` reports
	 * `uncertainty_m = round(raw × factor)` and preserves the raw value under `uncertainty_raw_m`.
	 *
	 * The factor is a property of the CALIBRATION SET the artifact was built against, so it ships IN the artifact:
	 * {@link InterpolationLookup.radiusCalibration} (the extract's `interp_calibration` metadata table, read at open
	 * time) is the default whenever this option is absent. Absent + artifact-silent = raw heuristic (byte-stable —
	 * extracts predating the metadata table; production callers fall back to their in-code per-region table for those).
	 * Report: docs/articles/evals/calibration/2026-06-14-interp-radius-calibration.md.
	 *
	 * @internal Instrument knob (D3) — measurement decomposition + legacy-extract fallback only; the artifact header IS
	 *   the shipped calibration. Set it only to override the artifact's value.
	 */
	interpolationRadiusCalibration?: number
	/**
	 * Street-centroid tier (#1042): consulted for a STREET-ONLY query (a street/thoroughfare with NO house number) that
	 * neither the address-point nor the interpolation tier can serve. On a hit, injects/stamps a resolved `street` node
	 * carrying the street's centroid under a DISTINCT metadata key (`street_centroid`, `resolution_tier: "street"`,
	 * `uncertainty_m`) — never `address_point`/`interpolated_point`, so a consumer reading the exact keys never gets a
	 * coarse centroid mislabeled as a rooftop. The thoroughfare + commune are recovered raw-text-first (the FR no-street
	 * class mis-parses the thoroughfare as a locality — #901 composition-insensitive), so the tier rides the model where
	 * it works and recovers where it fails.
	 *
	 * A COUNTRY-KEYED PROVIDER (not a bare lookup) because the country signal for a street-only query is unreliable
	 * BEFORE resolution: a bare thoroughfare ("Avenue des Champs-Élysées, Paris") is a bare-locality tree the placer is
	 * skipped on, and the placer mis-routes some French streets ("Rue Sainte-Catherine" → IT). So the tier probes a UNION
	 * of candidate countries — {@link streetCountryHints} (pre-resolution: defaultCountry + the unrestricted placer) PLUS
	 * the countries the tree actually RESOLVED to — and the exact (street, base-commune) match is itself the country
	 * filter. Opt-in; absent = byte-stable. Never fires when a house number is present (rooftop tiers untouched) or when
	 * a street-level coordinate already resolved.
	 */
	streetCentroids?: (country: string) => StreetCentroidLookup | undefined
	/**
	 * Ordered pre-resolution country hints for the {@link streetCentroids} tier — the caller's defaultCountry and the
	 * (unrestricted) coarse-placer country. The tier unions these with the resolved-tree countries. Absent = only the
	 * resolved countries are tried.
	 */
	streetCountryHints?: readonly string[]
	/**
	 * Span-rescore tier (#370). When the tree resolved nothing, recover a dropped/fragmented locality from the raw text:
	 * enumerate raw-token spans, exact-match the same-country gazetteer (longest-wins + postcode-consistency check), and
	 * inject the recovered locality as a resolved node. Targets the EU no-result tail the model leaves when it fragments
	 * an accented locality token ("Grudziądz" → "Grudzi"+"dz", #555). **Default-ON** (promoted 2026-06-25 — same-harness
	 * EU+AU +1pp @25km, zero regressions); set `false` to opt out (byte-stable then). Never disturbs a tree that already
	 * resolved (the #685 brake). Validated in `docs/articles/evals/experiments/2026-06-23-370-span-rescore.mdx` +
	 * `2026-06-25-eu-competitive-standing.md`.
	 */
	spanRescore?: boolean
	/**
	 * Postcode-consistency check radius (km) for the span-rescore tier — reject a recovered locality farther than this
	 * from where the postcode resolves. Only bites when the backend has postcode coverage (else no anchor, no check).
	 * Default 50.
	 */
	spanRescoreThresholdKm?: number
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
	 * **Default ON** (operator-promoted 2026-07-03 after the pre-registered promotion eval: SI 25/25 recovery at p50 0.67
	 * km, US/FR byte-identical, and the insurance leg — the composition-failed v2.2.0 candidate recovers all 55 lost
	 * rows). Set `false` to opt out (byte-stable then).
	 */
	postalCompoundRecovery?: boolean
	/**
	 * Postcode-disambiguated locality selection (#370 "Change A"). When set, AND a locality resolves far from a resolved
	 * sibling postcode, re-pick the same-named candidate (from the lookup's already- captured `alternatives`) nearest the
	 * postcode; if none reconciles within the radius, fall the coordinate back to the postcode point and flag
	 * `postcode_city_mismatch`. Targets the dominant failure mode on the EU/AU panel — a same-named town resolved to the
	 * wrong instance while the postcode that would disambiguate it sits resolved in the same tree (e.g. "06260
	 * Saint-Pierre" → 617 km off, postcode 06260 correct). Only bites where the backend resolved the postcode to a point
	 * (so it composes with postcode coverage, #193).
	 *
	 * **Default ON** (operator-promoted 2026-07-04 after the corrected promotion eval: FI 231 wins / 0 losses, SI 37/6,
	 * CZ 47/2, US aggregates byte-flat with 9/2,000 rows touched — the four losses being two golden-data errors the pass
	 * correctly flags as `postcode_city_mismatch` and one bad ZIP centroid). Explicit `false` opts out (byte-stable
	 * then).
	 */
	postcodeConsistency?: boolean
	/**
	 * Check radius (km) for {@link postcodeConsistency} — a locality farther than this from the resolved postcode is
	 * re-picked or demoted. Default 50.
	 */
	postcodeConsistencyThresholdKm?: number
	/**
	 * Postcode-country coherence (#42) — the ONLY mechanism permitted to override {@link defaultCountry}, and the only
	 * one that runs BEFORE the walk rather than re-picking after it.
	 *
	 * `12 Rue de Rivoli, 75001 Paris` under the en-US locale resolves to Paris, **Texas**: the locale's region subtag
	 * becomes `defaultCountry: "US"`, the backend turns that into a hard `spr.country = 'US'` filter, and the candidate
	 * pool is all-US before ranking begins — so a coarse placer that called the address FR at confidence 0.9999908844 has
	 * nothing to promote (a soft re-rank downstream of a hard filter is inert by construction). With the postal extracts
	 * attached it degrades further: the postcode resolves to ZIP 75001 (Addison TX) and {@link postcodeConsistency} then
	 * drags the locality onto that point.
	 *
	 * The postcode's SHAPE cannot settle this — `75001` is a valid US ZIP, French CP and German PLZ, and the gazetteer
	 * holds the literal string in four countries. Its GEOMETRY can: this pass asks, per candidate country from codex's
	 * shape test, whether the postcode resolves there AND a same-named locality sits within
	 * {@link postcodeCountryCoherenceThresholdKm} of it — then scopes the whole walk to the country where the pair is
	 * consistent. Measured over 800 real pairs (400 US ZIP+city, 400 FR CP+commune): **zero** border crossings at both
	 * the 15 km and 25 km radii.
	 *
	 * Soft by construction, per the positive-evidence-only rule: the caller's `defaultCountry` is tested FIRST and a
	 * coherent default always wins (returning immediately, ≤2 lookups, byte-identical walk), and both zero coherent
	 * countries and two-or-more abstain. It fires only when a `defaultCountry` is in force AND the tree carries both a
	 * postcode and a locality AND the default cannot make them consistent.
	 *
	 * **Default ON** (operator-promoted 2026-08-05 after the D-rule evidence in
	 * `docs/records/evals/2026-08-05-postcode-coherence-default-on-evidence.md`: the standard gauntlet run pinned both
	 * ways produced ZERO newly-failing restricted cases — 65/68 either way, the same three unrelated failures — and
	 * 56,000 pair evaluations across BOTH backends (28,000 FTS + 28,000 candidate; OpenAddresses US/FR + OSM GB, domestic
	 * and mis-scoped legs) returned zero false positives. The rescue leg fixes ~9 in 10 mis-scoped defaults. Set `false`
	 * to opt out (byte-stable then). Costs 2 lookups on the byte-stable path, at most 8 when it fires.
	 *
	 * Reach is bounded by codex's `candidateSystemsForPostcode` and the attached gazetteer: measured 2026-08-05 it can
	 * speak for US/DE/FR/GB on the production FTS extract set and additionally CA/AU on the candidate table; JP and NZ
	 * have a codex slice with no postcode rows behind it, so the pass abstains there at the cost of its two lookups.
	 */
	postcodeCountryCoherence?: boolean
	/**
	 * Check radius (km) for {@link postcodeCountryCoherence} — how near a same-named locality must sit to the resolved
	 * postcode to count that country as consistent. Default 25 (what the 800-pair scale run measured; the confound board
	 * returned identical verdicts at 15, 25 and 50, so the pass is not radius-tuned).
	 */
	postcodeCountryCoherenceThresholdKm?: number
	/**
	 * Postcode-shape coherence (#31, Mechanism 1, `resolver/postcode-shape-coherence.ts`) — shape as CONFIDENCE and
	 * EXCLUSION, downstream of the siblings. The decoder sometimes tags a HOUSE NUMBER as `postcode` when its digits form
	 * a foreign postcode shape ("1200" in a Longmont CO address is accepted only by the AU/NZ 4-digit shape while every
	 * sibling placetype says US). This pre-walk pass intersects each postcode span's codex candidate systems with the
	 * systems the tree's country / region / `country_hint` siblings assert: a non-empty intersection CONFIRMS the span
	 * (additive `postcode_shape_systems` stamp, byte-identical resolution); an empty intersection with confident siblings
	 * EXCLUDES it (a digit-only span is demoted to `house_number`, a letter-bearing one keeps its tag with a
	 * `postcode_shape_excluded` stamp — either way the span's contribution to the resolve is stripped); no confident
	 * siblings ABSTAIN. `defaultCountry` is never evidence (B1-3's confound: "Sydney NSW 2000, Australia" reached with a
	 * US default must not have its 2000 excluded — that row is exactly what {@link postcodeCountryCoherence} rescues).
	 * Confirmed spans narrow the country-scope pass's candidate list to the intersection (a pure subset, safe).
	 *
	 * **Default OFF** (D-rule: demotion is the failure mode with teeth — a default-on promotion needs the full B1
	 * criterion set from `docs/superpowers/plans/2026-08-05-postcode-structure-arc.md`: B1-1 byte-stability, B1-2
	 * exclusion board ≥90% with the correct sibling tag surviving, B1-3 confound ≤2% false exclusions, kill on any δ).
	 */
	postcodeShapeCoherence?: boolean
	/**
	 * Postcode-containment coherence (#31, Mechanism 2) — the reverse arrow, generalized. When a locality-wanting query
	 * carries a postcode and the #741 exact `(name_key, postcode)` probe misses, a coordinate-first backend resolves the
	 * postcode's centroid once and re-ranks the name candidates by distance to it, bounded by a 25 km containment rate —
	 * "Paris TX 75460" and "Paris 75001" differ by which candidate the postcode is near, and the population ranking
	 * cannot see that. Strictly beneath the #741 short-circuit (B2-1: byte-identical wherever the fast path fires); no
	 * in-radius candidate → unchanged (B2-2's postcode-removed arm). Rides `FindPlaceQuery.postcodeContainmentCoherence`
	 * to the backend.
	 *
	 * **Default OFF.** The promotion decision must measure it JOINTLY with {@link postcodeConsistency} (B2-3: the arms
	 * agree on ≥98%), because this rung partially subsumes #370 — the compliant outcome may be that mechanism 2 replaces
	 * it rather than joining it. B2-4: one postcode lookup per locality miss, ≤15% p95 latency.
	 */
	postcodeContainmentCoherence?: boolean
	/**
	 * Postcode-prefix prior (#31, Mechanism 3) — the partial-code prior for postcodes the full-code gazetteer does not
	 * carry (#1480's abstention, e.g. a BT unit with no permissive source behind it). When a `postalcode` lookup misses
	 * AND a {@link postcodePrefixIndex} for the query's country is supplied, derive the code's prefix (GB: outward — the
	 * compact form minus its trailing 3 unit chars; US: the first 3 digits) and probe the index. A hit resolves the node
	 * from the prefix's centroid and/or ancestry: `metadata.postcode_prefix`, `postcode_prefix_ancestors` (+
	 * `postcode_prefix_radius_p95_km` when the artifact measured one), and `coordinate_source: "postcode_prefix"` only
	 * when the node actually carries a coordinate — an ancestry-only tier (NI's 80 BT districts) contributes its DISTRICT
	 * and stays coordinate-free (the meaning-of-zero rule; inventing a BT centroid would reproduce the `BT3 9QQ` →
	 * Sheffield defect #1480 just fixed).
	 *
	 * **Default OFF** (D-rule + the PCN1 posture: data + loader + offline probe, no decode wiring; the header ships
	 * without `delta` until a calibration measures one). B3-5: the probe touches zero model inputs — the index is a
	 * structural type (`PostcodePrefixIndexLike`), injected, never imported from `@mailwoman/neural`.
	 */
	postcodePrefixPrior?: boolean
	/**
	 * #1589 — countries the parsed postcode's FORMAT implies (the #928 unforgeable singles plus the shared `NNN NN`
	 * CZ/SK/SE/GR family). Applied by the `postalcode` lookup ONLY when no country constraint survives (an explicit
	 * `defaultCountry` outranks format evidence, which outranks a locale hint): the lookup probes exactly the implied
	 * countries, keeps the most populous hit, and abstains when all miss rather than falling through to a fold-colliding
	 * unconstrained probe.
	 */
	postcodeFormatCountries?: readonly string[]
	/**
	 * The PFX1 postcode-prefix index to probe when {@link postcodePrefixPrior} is on — injected by the pipeline (loaded
	 * from `$MAILWOMAN_DATA_ROOT/postcode-prefix/postcode-prefix-<cc>.bin`), never constructed here. Structural
	 * (`PostcodePrefixIndexLike`), so the resolver consumes an index built in `@mailwoman/neural` without depending on it
	 * (B3-5).
	 */
	postcodePrefixIndex?: PostcodePrefixIndexLike
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
	/**
	 * Dual-role completion (#387, generalized by #405). Some places are two things at once — Singapore is a country AND a
	 * city, Washington DC a region AND a locality — but the address writes one span, so the tree resolves a region and
	 * carries no locality node even though the place genuinely is one.
	 *
	 * When a region resolved and no locality span is present, this asks the gazetteer's `coincident_roles` relation
	 * (#403, via {@link ResolverBackend.coincidentLocalitiesFor}) whether that region also functions as a locality, and
	 * ATTACHES a second reading to the same node. The region answer is untouched; the locality reading rides alongside it
	 * in `interpretations`, stamped `resolver_completed` so a consumer can tell it was inferred rather than parsed.
	 *
	 * **Default-ON, and on the shipped default backend it currently does nothing.** `WOFCandidateTableLookup` implements
	 * neither `coincidentLocalitiesFor` nor `ancestors` — `candidate.db` carries no such table — so the guard returns and
	 * no interpretation is attached. `Resolver.capabilityGaps` reports that at construction rather than leaving it
	 * silent.
	 *
	 * Measured 2026-08-15 on the FTS backend, which DOES implement both: toggling this flag changed **0 of 837** board
	 * inputs. The capability and its measured value on everything we currently test is zero, which is why `candidate.db`
	 * was not grown to support it (#1667, closed not-planned). Reopen on a consumer that needs it.
	 *
	 * `false` opts out; byte-stable either way on any backend lacking the relation.
	 */
	hierarchyCompletion?: boolean
	/**
	 * Attach each resolved node's ancestor lineage (#404) — the containment chain (county → region → country) the
	 * backend's {@link ResolverBackend.ancestors} returns — onto `metadata.ancestors`. The Pelias/Nominatim
	 * "always-attach-the-hierarchy" enrichment, so a consumer gets the full admin ladder from a single resolved place.
	 * OFF by default: omit it and resolution is byte-identical (and there's no extra query). Only attaches to nodes the
	 * resolver actually resolved.
	 */
	includeAncestors?: boolean
	/**
	 * Admin-containment re-rank (#1717 stage 2) — make a parsed REGION qualifier participate in locality-candidate
	 * selection. `Weimar, Thüringen` under the en-US locale resolves to Weimar, Texas: the locale-inferred
	 * `defaultCountry` becomes a hard `country` filter on the locality lookup, so the candidate pool is all-US before any
	 * comparator runs — the qualifier the parse got RIGHT never reaches the deciding site (the #1729 lesson, measured
	 * again here: the DE row is simply not in the list). The coherence passes cannot reach this class either:
	 * `applyAdminCoherence` needs the locality to have FAILED, `applyRegionCountryCoherence` expands only the codex US+CA
	 * subdivision table, and there is no postcode for #42 to re-scope by.
	 *
	 * When on, the walk threads the tree's first region-tagged span onto every locality lookup
	 * (`FindPlaceQuery.regionQualifier`); a capable backend answers containment from its ancestors sidecar — stamping
	 * `ResolvedPlace.containedByQualifier` and ADDING contained same-name candidates a locale-inferred country scope hid
	 * — and the walk finishes with a TIER-SAFE stable partition: contained candidates ahead of uncontained ones, within
	 * the exact-match tier, preserving each group's relative order. The partition runs AFTER the fame/anchor re-ranks
	 * because the qualifier is the address's OWN text — evidence, which outranks a prior (the same precedence
	 * `anchorPosterior` holds over `rankByImportance`).
	 *
	 * Soft by construction: candidates are only ever added or reordered, never dropped, so a qualifier that matches
	 * nothing (or contains no same-name candidate) leaves the answer byte-identical. Stands down under an EXPLICIT caller
	 * `defaultCountry` (the #912 posture: only a locale-INFERRED scope is bypassable by the address's own evidence). Each
	 * locality pick records `metadata.admin_containment`: `"contained"` (the sidecar vouched for at least one candidate),
	 * `"no_contained_candidate"` (evaluated, none contained), or `"unavailable"` (the backend or artifact cannot answer —
	 * a pre-sidecar candidate.db, the FTS/browser backends) — so an inert change is visible in the trace rather than
	 * silently dead (#1719's rule; the parse-side census cannot see resolver changes, so the stamp is the census surface
	 * here).
	 *
	 * **Default OFF** (D-rule): opt in and measure; the promotion battery is the full board + gauntlet + parity ON/OFF
	 * with one declared variable.
	 */
	adminContainmentRerank?: boolean
	/**
	 * Resolver-interior trace sink (#1721): when set, the walk emits one {@link ResolveNodeTrace} per candidate lookup —
	 * the query as sent, the candidate table with per-stage ranks, every check that fired, and the pick's provenance — so
	 * "the right row was present at rank 3 and lost to the fame term" is a recorded fact instead of a spelunking result.
	 * Absent (the default) the walk does ZERO trace bookkeeping and stays byte-identical; the sink is a hot-path opt-in
	 * for debug surfaces, never a production default.
	 */
	traceSink?: (record: ResolveNodeTrace) => void
	/**
	 * When a lookup resolves NOTHING, re-probe the same value across the other admin bands and record which ones hold it
	 * ({@link ResolveNodeTrace.reachableIn}) — a DIAGNOSTIC that never changes the answer.
	 *
	 * The distinction it buys is the one a `null` cannot carry: a key we hold under a different placetype is a
	 * REACHABILITY failure — the model's tag chose the band, and a wrong tag makes a row we own unreachable — while a key
	 * that exists nowhere is a coverage fact. Those call for opposite work and today reach a caller identically.
	 *
	 * Costs one extra backend call per band per miss, so it is off by default and belongs to debug surfaces. Requires
	 * `traceSink`: with no sink there is nowhere to record the answer, and the probes would be pure cost.
	 */
	diagnoseUnreachable?: boolean
}

/**
 * One candidate as the resolver's deciding site saw it — the fields the ranking stages actually read, plus a per-stage
 * rank vector. `ranks` carries one entry per stage that RAN, in execution order (`initial` = the backend's own order;
 * then whichever of `anchor`, `locale_prior`, `importance`, `containment`, `exact_type` were active); a stage a
 * candidate set never went through is absent, never defaulted. The vector is what makes loss attributable: the stage
 * whose entry moved a row down is the term it lost to.
 */
export interface ResolveCandidateTrace {
	id: string | number
	name: string
	/**
	 * Optional for the same reason as {@link ResolvedPlace.country}: the trace mirrors the candidate, and a candidate can
	 * carry no country.
	 */
	country?: string
	placetype: string
	score: number
	prominence?: number
	importance?: number
	population?: number
	exactMatch?: boolean
	containedByQualifier?: boolean
	ranks: Record<string, number>
}

/**
 * One `ResolveNodeTrace` per backend lookup the walk performed (#1721) — and one per POST-WALK recovery that answers
 * off the walk (`span_rescore`, `postal_compound_recovery`), so no resolved coordinate is off the record. `checks`
 * records mechanism events in execution order, in the resolver's own vocabulary (`parent_fallback_retry`,
 * `region_scope_miss`, `backend_error`, `postcode_format_probe`, `postcode_prefix_prior`, `bare_race`,
 * `empty_admin_pick`, `min_score_reject`, `bare_country_repick`, `bare_region_repick`, `placetype_fallback`). `picked:
 * null` states the lookup resolved nothing — a claim, not an omission. The candidate table is capped
 * ({@link ResolveNodeTrace.candidatesTruncated} counts the tail) so a trace stays a record, not a dump.
 */
export interface ResolveNodeTrace {
	tag: string
	value: string
	placetype: string
	query: {
		country?: string
		parentID?: string | number
		postcode?: string
		regionQualifier?: string
		limit: number
	}
	checks: string[]
	/**
	 * Which OTHER admin bands hold this value, probed only when the lookup resolved nothing and
	 * {@link ResolveOpts.diagnoseUnreachable} is on.
	 *
	 * `[]` is a measured absence — every band was asked and none held it, so the miss is coverage. `undefined` means
	 * nobody asked, which is a different fact and must not be read as an empty answer.
	 */
	reachableIn?: Array<{ placetype: string; n: number }>
	candidates: ResolveCandidateTrace[]
	candidatesTruncated: number
	picked: {
		id: string | number
		name: string
		source:
			| "ranked"
			| "bare_country"
			| "bare_region"
			| "postcode_prefix"
			| "postcode_format_probe"
			| "empty_admin"
			| "span_rescore"
			| "postal_compound_recovery"
	} | null
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
	/**
	 * Direct gazetteer probe, passed through from the {@link ResolverBackend} — for pipeline-level consumers that need one
	 * lookup outside a tree walk (the #1738 dominant-bearer guard on the coarse placer's hard-country promotion is the
	 * first). Optional like the members below: a resolver without it degrades its consumers to their without-the-probe
	 * behavior, never to a crash.
	 */
	findPlace?: ResolverBackend["findPlace"]
	/**
	 * Facts the loaded gazetteer artifact declares about itself, passed through from the {@link ResolverBackend} so
	 * pipeline-level consumers (the hard-country coverage check, guard-B plausibility) read them from the handle they
	 * already hold. Absent = artifact predates the manifest → code-constant fallback.
	 */
	artifactCoverage?: GazetteerArtifactCoverage
	/**
	 * Optional backend methods this resolver's backend does not implement, each naming the default-ON option it silently
	 * disables. Empty means every default-ON option has the support it needs; absent means the resolver predates the
	 * check. See {@link BackendCapabilityGap}.
	 */
	capabilityGaps?: readonly BackendCapabilityGap[]
}
