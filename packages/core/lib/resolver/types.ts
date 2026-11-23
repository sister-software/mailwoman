// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { PlacetypeMap } from "@mailwoman/codex/labels/placetype-map"

import type { AddressTree } from "#decoder/types"
import type { GazetteerArtifactCoverage } from "#resolver/coverage-facts"
import type {
	AddressPointLookup,
	InterpolationLookup,
	PostcodePrefixIndexLike,
	StreetCentroidLookup,
} from "#resolver/lookup-types"

/**
 * Why a place's ranking score is a rank without a measurement behind it.
 *
 * `population_unrecorded`: the backend ranks by population and the gazetteer records
 * none for the place, so its score is the rank an unknown population sorts to.
 * `population_estimated`: the gazetteer records no population for the place,
 * and its score ranks a population estimated from the settlement that contains it.
 * `unrecorded`: the resolver recorded no score for the place.
 */
export const ScoreUnmeasuredReason = {
	PopulationUnrecorded: "population_unrecorded",
	PopulationEstimated: "population_estimated",
	Unrecorded: "unrecorded",
} as const

export type ScoreUnmeasuredReason = (typeof ScoreUnmeasuredReason)[keyof typeof ScoreUnmeasuredReason]

/**
 * Why a candidate-table row's score, `-neg_rank` with `neg_rank = -log10(population + 1)`,
 * has no measured population behind it, or null when it has one.
 *
 * A row with no population and a negative `neg_rank` was ranked by a population estimate.
 */
export function populationScoreUnmeasured(
	population: number | null | undefined,
	negRank: number
): ScoreUnmeasuredReason | null {
	if (typeof population === "number" && population > 0) return null

	return negRank < 0 ? ScoreUnmeasuredReason.PopulationEstimated : ScoreUnmeasuredReason.PopulationUnrecorded
}

export interface ResolvedPlace {
	/**
	 * Resolver-specific place identifier.
	 */
	id: number | string
	/**
	 * Canonical place name.
	 */
	name: string
	/**
	 * Resolver placetype label.
	 */
	placetype: string
	/**
	 * ISO 3166-1 alpha-2 country code, if known.
	 */
	country: string | null
	/**
	 * Centroid latitude.
	 */
	lat: number
	/**
	 * Centroid longitude.
	 */
	lon: number
	/**
	 * Parent place id, if any.
	 */
	parent_id: number | string | null
	/**
	 * Resolver-defined ranking score.
	 *
	 * The ranking stages compare it whether or not `scoreUnmeasured` is set.
	 */
	score: number
	/**
	 * Why `score` and `prominence` are unmeasured for this place: each value is
	 * the rank an unmeasured input sorts to.
	 *
	 * Null or absent when the backend measured the score.
	 */
	scoreUnmeasured?: ScoreUnmeasuredReason | null
	/**
	 * Optional backend prominence score.
	 */
	prominence: number | null
	/**
	 * Optional raw population.
	 */
	population: number | null
	/**
	 * Optional referential likelihood in [0, 1].
	 */
	referential: number | null
	/**
	 * Optional strict encyclopedia importance in [0, 1].
	 */
	encyclopedic: number | null
	/**
	 * Optional blended global toponym prior in [0, 1].
	 */
	importance: number | null
	/**
	 * Optional exact name/alias match marker.
	 */
	exactMatch: boolean | null
	/**
	 * Optional postcode/locality mismatch marker.
	 */
	mismatch?: boolean | null
	/**
	 * Optional fallback-quality marker.
	 */
	resolutionQuality?: "fallback" | null
	/**
	 * Optional admin-containment verdict.
	 */
	containedByQualifier?: boolean | null
	/**
	 * Optional marker for a miss under parent scope.
	 */
	regionScopeMiss?: boolean | null
	/**
	 * Optional marker for variant-alias exemption.
	 */
	variantAliasExempted?: true | null
	/**
	 * True when the input matched an alias of this place and differs from its primary name.
	 */
	matchedAlias?: true | null
	/**
	 * True when a hard scope excluded this place: it lies outside the default country
	 * or the caller's parent place.
	 *
	 * The resolver sets it only on a place it lists on a node's `considered` list.
	 */
	outsideScope?: true | null
	/**
	 * Optional stored extent.
	 * A point-only row stores its coordinate as both corners.
	 */
	bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null
}

/**
 * The nullable {@link ResolvedPlace} signals, each `null`, spread first into a place literal.
 */
export const EMPTY_PLACE_FIELDS = Object.freeze({
	country: null,
	parent_id: null,
	prominence: null,
	population: null,
	referential: null,
	encyclopedic: null,
	importance: null,
	exactMatch: null,
}) satisfies Partial<ResolvedPlace>

export interface ResolverBackend {
	findPlace(query: {
		text: string
		placetype?: string | string[]
		country?: string
		/**
		 * Country scope for fuzzy tier only.
		 */
		fuzzyCountry?: string
		parentID?: number | string
		/**
		 * A resolved parent place whose containment orders the candidates and admits
		 * contained sub-locality rows the placetype filter excludes.
		 *
		 * `parentID` is a region scope filter and this is a ranking qualifier, so a query sets one of them.
		 */
		parentQualifierID?: number
		/**
		 * The postcode of a sibling, when present.
		 */
		postcode?: string
		/**
		 * Enables postcode-containment coherence in capable backends.
		 */
		postcodeContainmentCoherence?: boolean
		/**
		 * Optional proximity-bias points.
		 */
		bias?: Array<{ lat: number; lon: number; weight?: number }>
		/**
		 * Restrict matches to primary-keyed rows.
		 */
		primaryOnly?: boolean
		/**
		 * Alias name roles to exclude.
		 */
		excludeNameRoles?: readonly string[]
		/**
		 * Parsed region qualifier, if any.
		 */
		regionQualifier?: string
		limit?: number
	}): Promise<ResolvedPlace[]>
	/**
	 * Optional ancestor lineage lookup.
	 */
	ancestors?(id: number | string): Ancestor[]
	/**
	 * Optional lookup of one place by its id, or null when the gazetteer holds no such place.
	 */
	place?(id: number): ResolvedPlace | null
	/**
	 * Optional artifact coverage facts.
	 */
	artifactCoverage?: GazetteerArtifactCoverage | null
}

export interface Ancestor {
	id: number | string
	placetype: string
	name: string
}

/**
 * A reading used for weak-resolution span-rescore behavior.
 */
export type WeakResolutionReading = "score" | "containment" | "either"

/**
 * What a landmark row is: a place the layer answers, or a settlement the admin ladder answers.
 */
export type LandmarkKind = "venue" | "settlement"

/**
 * One place a landmark name belongs to.
 */
export interface LandmarkHit {
	/**
	 * The Wikidata item.
	 */
	qid: string
	name: string
	kind: LandmarkKind
	country: string | null
	lat: number
	lon: number
	/**
	 * The number of Wikipedia language editions that describe the place.
	 */
	sitelinks: number
	/**
	 * Whether the name is the place's own English or local name, rather than a translation or alias.
	 */
	primary: boolean
	/**
	 * Whether the input wrote an identifier code of the place, such as `DTW`, in its own case.
	 */
	code: boolean
	/**
	 * The importance Photon's index holds for an OpenStreetMap place, in place of a sitelink count.
	 */
	importance?: number | null
}

/**
 * The stable ID prefix of a landmark that came from OpenStreetMap, as in `osm:W427818536`.
 */
export const OSM_LANDMARK_PREFIX = "osm:"

/**
 * Parses the resolver's `placeID` URI back to a WOF id, returning `null` for anything else
 * so a future non-WOF backend isn't silently read as one.
 */
export function wofIDFromPlaceID(placeID: string | null): number | null {
	if (!placeID) return null

	const match = /^wof:(\d+)$/.exec(placeID)

	return match ? Number(match[1]) : null
}

/**
 * Returns a landmark's place ID: `openstreetmap:W427818536` or `wikidata:Q160409`.
 */
export function landmarkPlaceID(id: string | number): string {
	const value = String(id)

	return value.startsWith(OSM_LANDMARK_PREFIX)
		? `openstreetmap:${value.slice(OSM_LANDMARK_PREFIX.length)}`
		: `wikidata:${value}`
}

/**
 * Finds the places a name belongs to, primary names first, then most sitelinks first.
 */
export interface LandmarkLookup {
	find(name: string): LandmarkHit[] | Promise<LandmarkHit[]>
}

/**
 * A former administrative division whose name an input wrote, with the current
 * places its containment evidence ties it to.
 */
export interface FormerDivisionMatch {
	name: string
	/**
	 * Upper-case ISO 3166-1 alpha-2 code.
	 */
	country: string
	/**
	 * The GeoNames feature code (`ADM1H`) or the WOF placetype of a ceased record.
	 */
	kind: string
	/**
	 * The `ComponentTag` the division takes in an address.
	 */
	tag: string
	geonamesID: number | null
	wofID: number | null
	/**
	 * WOF ids of the current places the division covered.
	 */
	linkedIDs: ReadonlySet<number>
	/**
	 * The kinds of evidence the links rest on.
	 */
	evidence: readonly string[]
}

/**
 * Finds the former divisions a written name belongs to.
 */
export interface FormerDivisionLookup {
	/**
	 * The former divisions whose name keys the same as `value`, in `country` when one is given.
	 */
	divisionsNamed(value: string, country: string | null): readonly FormerDivisionMatch[]
}

/**
 * Who chose a default country scope.
 *
 * - `"caller"`: the caller asked for the country.
 * - `"inferred"`: the locale supplied it.
 *   `country` lookups ignore an inferred scope, and stronger evidence in the input can override it.
 */
export type DefaultCountrySource = "caller" | "inferred"

/**
 * How a scope acts on a lookup.
 *
 * - `"hard"`: a filter.
 *   A candidate outside the scope never answers.
 * - `"soft"`: a bounded prior.
 *   A candidate outside the scope still answers when it's much larger.
 */
export const ScopeStrength = {
	Hard: "hard",
	Soft: "soft",
} as const

export type ScopeStrength = (typeof ScopeStrength)[keyof typeof ScopeStrength]

/**
 * A default top-level country scope for resolution.
 */
export interface DefaultCountry {
	/**
	 * ISO 3166-1 alpha-2 code.
	 */
	country: string
	source: DefaultCountrySource
	/**
	 * How the scope acts on a lookup.
	 *
	 * Absent means `"hard"`.
	 */
	strength?: ScopeStrength
}

/**
 * The country of a scope that filters lookups, or null when the scope is absent or soft.
 */
export function hardCountryOf(scope: DefaultCountry | null | undefined): string | null {
	return scope && scope.strength !== ScopeStrength.Soft ? scope.country : null
}

/**
 * A caller-supplied place that scopes every lookup of an address, such as a WOF borough or country.
 *
 * A hard parent keeps only candidates its ancestor lineage agrees with:
 * the places inside it, the place itself and its ancestors.
 * It also filters by the parent's country.
 *
 * A soft parent ranks the candidates it contains first and gives its country a soft scope.
 * Both forms pass the parent to the backend as a containment qualifier.
 */
export interface ParentPlaceScope {
	/**
	 * The gazetteer id of the parent place.
	 */
	id: number
	source: DefaultCountrySource
	strength: ScopeStrength
}

/**
 * The on/off resolver passes and tiers, every one resolved against {@link RESOLVE_SWITCH_DEFAULTS}.
 *
 * Each is an optional {@link ResolveOpts} key.
 * The resolver reads them only through {@link resolveSwitches}, so a default lives in exactly one place.
 */
export interface ResolveSwitches {
	parentFallback: boolean
	addressPointBboxFallback: boolean
	spanRescore: boolean
	postalCompoundRecovery: boolean
	postcodeConsistency: boolean
	postcodeCountryCoherence: boolean
	postcodeShapeCoherence: boolean
	postcodeContainmentCoherence: boolean
	postcodePrefixPrior: boolean
	adminCoherence: boolean
	includeAncestors: boolean
	adminContainmentRerank: boolean
	dependentLocalityContainment: boolean
	countyDesignatorFallback: boolean
	formerDivisions: boolean
	scopeCountryRetrieval: boolean
	siblingLocalityContainment: boolean
	diagnoseUnreachable: boolean
}

/**
 * The default of every {@link ResolveSwitches} key.
 */
export const RESOLVE_SWITCH_DEFAULTS: Readonly<ResolveSwitches> = {
	parentFallback: true,
	addressPointBboxFallback: false,
	spanRescore: true,
	postalCompoundRecovery: true,
	postcodeConsistency: true,
	postcodeCountryCoherence: true,
	postcodeShapeCoherence: true,
	postcodeContainmentCoherence: false,
	postcodePrefixPrior: false,
	adminCoherence: true,
	includeAncestors: false,
	adminContainmentRerank: true,
	dependentLocalityContainment: true,
	countyDesignatorFallback: false,
	formerDivisions: false,
	scopeCountryRetrieval: false,
	siblingLocalityContainment: false,
	diagnoseUnreachable: false,
}

/**
 * Fills each unset switch from {@link RESOLVE_SWITCH_DEFAULTS}.
 */
export function resolveSwitches(opts: { [K in keyof ResolveSwitches]?: ResolveSwitches[K] | null }): ResolveSwitches {
	const switches = { ...RESOLVE_SWITCH_DEFAULTS }

	for (const key of Object.keys(RESOLVE_SWITCH_DEFAULTS) as (keyof ResolveSwitches)[]) {
		switches[key] = opts[key] ?? RESOLVE_SWITCH_DEFAULTS[key]
	}

	return switches
}

export interface ResolveOpts {
	/**
	 * Max backend lookups per tree.
	 */
	maxLookups?: number
	/**
	 * Minimum winning score threshold.
	 */
	minWinningScore?: number
	/**
	 * Max candidates requested per lookup.
	 */
	candidatesPerLookup?: number
	/**
	 * Default top-level country scope, who chose it, and whether it filters or ranks.
	 */
	defaultCountry?: DefaultCountry
	/**
	 * Country scope for fuzzy matching only.
	 */
	fuzzyCountryScope?: string
	/**
	 * Optional ordered proximity-bias points.
	 */
	bias?: Array<{ lat: number; lon: number; weight?: number }>
	/**
	 * Retry without parent constraint on scoped miss.
	 *
	 * @defaultValue {@linkcode RESOLVE_SWITCH_DEFAULTS}
	 */
	parentFallback?: boolean
	/**
	 * ComponentTag to resolver placetype mapping override.
	 */
	placetypeMap?: PlacetypeMap
	/**
	 * Optional locale hint.
	 */
	locale?: string
	/**
	 * Optional postcode-derived country posterior.
	 */
	anchorPosterior?: Record<string, number>
	/**
	 * Weight for anchorPosterior.
	 */
	anchorWeight?: number
	/**
	 * The bonus a soft country scope gives a candidate in its country, in log10-population units.
	 *
	 * @defaultValue `DEFAULT_COUNTRY_PRIOR_WEIGHT` from `@mailwoman/resolver/toponym-prior` (2)
	 */
	softCountryWeight?: number
	/**
	 * A caller-supplied parent place that scopes every lookup.
	 *
	 * It needs a backend with `place` and `ancestors`, and the resolve throws without them.
	 */
	parentPlace?: ParentPlaceScope
	/**
	 * Optional capital-level callback.
	 */
	capitalLevel?: (place: { name: string; country: string | null; lat: number; lon: number }) => number
	/**
	 * Optional hard country filter from coarse placer.
	 */
	hardCountry?: string
	/**
	 * Optional street-level address-point lookup.
	 */
	addressPoints?: AddressPointLookup
	/**
	 * Enables locality-bbox fallback in address-point lookup.
	 * @defaultValue {@linkcode RESOLVE_SWITCH_DEFAULTS}
	 */
	addressPointBboxFallback?: boolean
	/**
	 * Optional house-number interpolation lookup.
	 */
	interpolation?: InterpolationLookup
	/**
	 * Optional interpolation uncertainty calibration override.
	 */
	interpolationRadiusCalibration?: number
	/**
	 * Optional street-centroid provider by country.
	 */
	streetCentroids?: ((country: string) => StreetCentroidLookup | null) | null
	/**
	 * Optional pre-resolution country hints for street-centroid tier.
	 */
	streetCountryHints?: readonly string[]
	/**
	 * Enables span-rescore recovery tier.
	 *
	 * @defaultValue {@linkcode RESOLVE_SWITCH_DEFAULTS}
	 */
	spanRescore?: boolean
	/**
	 * Span-rescore postcode-consistency radius in km.
	 */
	spanRescoreThresholdKm?: number
	/**
	 * The landmark layer.
	 *
	 * It answers an input that's a place's name with no street or postcode.
	 */
	landmarks?: LandmarkLookup
	/**
	 * The OpenStreetMap place layer, read after span rescore with the same rules as the landmark layer.
	 */
	osmPlaces?: LandmarkLookup
	/**
	 * The input as the caller wrote it, because the parse may fold its case
	 * and a code such as `DTW` needs that case.
	 */
	writtenInput?: string
	/**
	 * Returns whether a word is a POI category, so span-rescore doesn't re-read
	 * a venue's last word as a locality.
	 */
	isVenueCategoryWord?: (word: string) => boolean
	/**
	 * Weak-resolution reading used by span-rescore.
	 */
	spanRescoreWeakResolution?: WeakResolutionReading
	/**
	 * Enables postal-compound recovery in span-rescore tier.
	 *
	 * @defaultValue {@linkcode RESOLVE_SWITCH_DEFAULTS}
	 */
	postalCompoundRecovery?: boolean
	/**
	 * Enables postcode-based locality disambiguation.
	 *
	 * @defaultValue {@linkcode RESOLVE_SWITCH_DEFAULTS}
	 */
	postcodeConsistency?: boolean
	/**
	 * Radius in km for postcodeConsistency checks.
	 */
	postcodeConsistencyThresholdKm?: number
	/**
	 * Max km allowed for postcode fallback coordinate movement.
	 */
	postcodeConsistencyMaxMoveKm?: number
	/**
	 * Enables postcode-country coherence pass.
	 *
	 * @defaultValue {@linkcode RESOLVE_SWITCH_DEFAULTS}
	 */
	postcodeCountryCoherence?: boolean
	/**
	 * Radius in km for postcode-country coherence checks.
	 */
	postcodeCountryCoherenceThresholdKm?: number
	/**
	 * Enables postcode-shape coherence pass.
	 *
	 * @defaultValue {@linkcode RESOLVE_SWITCH_DEFAULTS}
	 */
	postcodeShapeCoherence?: boolean
	/**
	 * Enables postcode-containment coherence pass.
	 *
	 * @defaultValue {@linkcode RESOLVE_SWITCH_DEFAULTS}
	 */
	postcodeContainmentCoherence?: boolean
	/**
	 * Enables postcode-prefix prior tier.
	 *
	 * @defaultValue {@linkcode RESOLVE_SWITCH_DEFAULTS}
	 */
	postcodePrefixPrior?: boolean
	/**
	 * Countries implied by postcode format.
	 */
	postcodeFormatCountries?: readonly string[]
	/**
	 * Injected postcode-prefix index.
	 */
	postcodePrefixIndex?: PostcodePrefixIndexLike
	/**
	 * Enables admin descendant-consistency correction.
	 *
	 * @defaultValue {@linkcode RESOLVE_SWITCH_DEFAULTS}
	 */
	adminCoherence?: boolean
	/**
	 * Attach ancestor lineage to resolved nodes.
	 *
	 * @defaultValue {@linkcode RESOLVE_SWITCH_DEFAULTS}
	 */
	includeAncestors?: boolean
	/**
	 * Reranks locality candidates by containment in a parsed region qualifier.
	 *
	 * It stands down under a caller-supplied `defaultCountry`.
	 *
	 * @defaultValue {@linkcode RESOLVE_SWITCH_DEFAULTS}
	 */
	adminContainmentRerank?: boolean
	/**
	 * Resolves a `dependent_locality` node inside its resolved parent.
	 *
	 * The lookup passes the parent as a containment qualifier.
	 * The ancestors sidecar then admits the sub-locality rows the locality band excludes.
	 *
	 * A pick the parent contains answers the coordinate ahead of the locality.
	 *
	 * @defaultValue {@linkcode RESOLVE_SWITCH_DEFAULTS}
	 */
	dependentLocalityContainment?: boolean
	/**
	 * Looks a `locality` span up as a WOF `county` in its resolved region
	 * when no locality of that name is there and the value is written with
	 * its country's county designator (`Harris County`, `Jefferson Parish`),
	 * from `countyNameWithoutDesignator` in `@mailwoman/codex/designators/county`.
	 *
	 * @defaultValue {@linkcode RESOLVE_SWITCH_DEFAULTS}
	 */
	countyDesignatorFallback?: boolean
	/**
	 * Accepts a `subregion` or `region` value that no current division answers when the value is the name
	 * of a former division of {@link ResolveOpts.formerDivisionLookup} linked to the resolved locality.
	 *
	 * The accepted node keeps no place and scopes no lookup, and its metadata records the division.
	 *
	 * @defaultValue {@linkcode RESOLVE_SWITCH_DEFAULTS}
	 */
	formerDivisions?: boolean
	/**
	 * The former divisions {@link ResolveOpts.formerDivisions} reads.
	 *
	 * Without it the switch leaves every node as the walk resolved it.
	 */
	formerDivisionLookup?: FormerDivisionLookup
	/**
	 * Lets a soft country scope act inside retrieval.
	 *
	 * A region or locality lookup without a hard country also retrieves the soft
	 * country's rows and merges them by place id.
	 * A bounded bonus for that country then runs after the importance rerank, so the rerank can't undo it.
	 *
	 * The soft scope is the locale's country when the walk withholds it for a bare tree,
	 * or the locale head's country when the head contradicts the inferred scope.
	 * A lookup under a hard default country also probes without it and reports the
	 * same-name places outside the scope on `considered`.
	 *
	 * @defaultValue {@linkcode RESOLVE_SWITCH_DEFAULTS}
	 */
	scopeCountryRetrieval?: boolean
	/**
	 * Resolves one of two `locality` spans inside the other when the gazetteer places
	 * a candidate of it inside the other's resolved place.
	 *
	 * The inner span is retagged `dependent_locality` and looked up with the outer place
	 * as its containment qualifier, as a written dependent locality is.
	 * The gazetteer decides which span is inner, so token order doesn't.
	 *
	 * @defaultValue {@linkcode RESOLVE_SWITCH_DEFAULTS}
	 */
	siblingLocalityContainment?: boolean
	/**
	 * Optional sink for resolver-internal trace records.
	 */
	traceSink?: ((record: ResolveNodeTrace) => void) | null
	/**
	 * Diagnose unresolved value reachability across placetypes.
	 *
	 * @defaultValue {@linkcode RESOLVE_SWITCH_DEFAULTS}
	 */
	diagnoseUnreachable?: boolean
}

/**
 * Candidate snapshot as seen by resolver ranking stages.
 */
export interface ResolveCandidateTrace {
	id: string | number
	name: string
	/**
	 * Optional country code.
	 */
	country: string | null
	placetype: string
	/**
	 * The ranking key the stages compared.
	 * It is unmeasured when `scoreUnmeasured` is set.
	 */
	score: number
	/**
	 * Why `score` and `prominence` are unmeasured, or null when they're measured.
	 *
	 * Optional because a trace recorded before the field existed holds no such entry.
	 */
	scoreUnmeasured?: ScoreUnmeasuredReason | null
	prominence: number | null
	importance: number | null
	population: number | null
	exactMatch: boolean | null
	containedByQualifier: boolean | null
	ranks: Record<string, number>
}

/**
 * Trace record for one resolver lookup or recovery operation.
 */
export interface ResolveNodeTrace {
	tag: string
	value: string
	placetype: string
	query: {
		country: string | null
		parentID: string | number | null
		/**
		 * The resolved parent a dependent locality's lookup ranked by containment (#2804).
		 *
		 * Optional because a trace recorded before the field existed holds no such entry.
		 * The recorder writes `null` when the lookup set no qualifier.
		 */
		parentQualifierID?: number | null
		postcode: string | null
		regionQualifier: string | null
		limit: number
	}
	checks: string[]
	/**
	 * Other placetypes where the value was reachable, if probed.
	 */
	reachableIn: Array<{ placetype: string; n: number }> | null
	candidates: ResolveCandidateTrace[]
	candidatesTruncated: number
	picked: {
		id: string | number
		name: string
		source:
			| "ranked"
			| "bare_country"
			| "bare_region"
			| "bare_sublocality"
			| "postcode_prefix"
			| "postcode_format_probe"
			| "empty_admin"
			| "span_rescore"
			| "postal_compound_recovery"
			| "county_designator_fallback"
			| "sibling_locality_containment"
	} | null
}

/**
 * Public resolver interface.
 */
export interface Resolver {
	resolveTree(tree: AddressTree, opts?: ResolveOpts): Promise<AddressTree>
	/**
	 * Optional direct place lookup passthrough.
	 */
	findPlace?: ResolverBackend["findPlace"]
	/**
	 * Optional artifact coverage facts passthrough.
	 */
	artifactCoverage: GazetteerArtifactCoverage | null
}
