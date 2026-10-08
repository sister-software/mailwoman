/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { PlacetypeMap } from "@mailwoman/codex/placetype-map"

import type { AddressTree } from "#decoder/types"
import type { GazetteerArtifactCoverage } from "#resolver/coverage-facts"
import type {
	AddressPointLookup,
	InterpolationLookup,
	PostcodePrefixIndexLike,
	StreetCentroidLookup,
} from "#resolver/lookup-types"

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
	 */
	score: number
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
	 * Optional coincident localities lookup.
	 */
	coincidentLocalitiesFor?(adminID: number | string): CoincidentLocality[]
	/**
	 * Optional ancestor lineage lookup.
	 */
	ancestors?(id: number | string): Ancestor[]
	/**
	 * Optional artifact coverage facts.
	 */
	artifactCoverage?: GazetteerArtifactCoverage | null
}

export interface BackendCapabilityGap {
	/**
	 * A backend capability that is absent.
	 */
	capability: "ancestors" | "coincidentLocalitiesFor"
	/**
	 * Related resolve option.
	 */
	option: keyof ResolveOpts
	/**
	 * Whether the option defaults to on.
	 */
	defaultOn: boolean
	/**
	 * User-visible degradation.
	 */
	degrades: string
	/**
	 * Backend class name.
	 */
	backend: string
}

export interface Ancestor {
	id: number | string
	placetype: string
	name: string
}

export interface CoincidentLocality extends ResolvedPlace {
	/**
	 * Relationship type.
	 */
	relationshipType: string
	/**
	 * Locality population.
	 */
	population: number
	/**
	 * Centroid distance in km.
	 */
	distanceKm: number
}

/**
 * A reading used for weak-resolution span-rescore behavior.
 */
export type WeakResolutionReading = "score" | "containment" | "either"

/**
 * Who chose a default country scope.
 *
 * - `"caller"`: the caller asked for the country.
 * - `"inferred"`: the locale supplied it.
 *   `country` lookups ignore an inferred scope, and stronger evidence in the input can override it.
 */
export type DefaultCountrySource = "caller" | "inferred"

/**
 * A default top-level country scope for resolution.
 */
export interface DefaultCountry {
	/**
	 * ISO 3166-1 alpha-2 code.
	 */
	country: string
	source: DefaultCountrySource
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
	spanRescoreRequireContextRemainder: boolean
	postalCompoundRecovery: boolean
	postcodeConsistency: boolean
	postcodeCountryCoherence: boolean
	postcodeShapeCoherence: boolean
	postcodeContainmentCoherence: boolean
	postcodePrefixPrior: boolean
	adminCoherence: boolean
	hierarchyCompletion: boolean
	includeAncestors: boolean
	adminContainmentRerank: boolean
	diagnoseUnreachable: boolean
}

/**
 * The default of every {@link ResolveSwitches} key.
 */
export const RESOLVE_SWITCH_DEFAULTS: Readonly<ResolveSwitches> = {
	parentFallback: true,
	addressPointBboxFallback: false,
	spanRescore: true,
	spanRescoreRequireContextRemainder: false,
	postalCompoundRecovery: true,
	postcodeConsistency: true,
	postcodeCountryCoherence: true,
	postcodeShapeCoherence: false,
	postcodeContainmentCoherence: false,
	postcodePrefixPrior: false,
	adminCoherence: true,
	hierarchyCompletion: true,
	includeAncestors: false,
	adminContainmentRerank: true,
	diagnoseUnreachable: false,
}

/**
 * Fills each unset switch from {@link RESOLVE_SWITCH_DEFAULTS}.
 */
export function resolveSwitches(opts: Partial<ResolveSwitches>): ResolveSwitches {
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
	 * Default top-level country scope, and who chose it.
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
	 * Optional locale country prior.
	 */
	localeCountryPrior?: string
	/**
	 * Weight for localeCountryPrior.
	 */
	localeCountryPriorWeight?: number
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
	 * Require contextual remainder for span-rescore sub-spans.
	 *
	 * @defaultValue {@linkcode RESOLVE_SWITCH_DEFAULTS}
	 */
	spanRescoreRequireContextRemainder?: boolean
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
	 * Enables dual-role hierarchy completion.
	 *
	 * @defaultValue {@linkcode RESOLVE_SWITCH_DEFAULTS}
	 */
	hierarchyCompletion?: boolean
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
	 * Optional sink for resolver-internal trace records.
	 */
	traceSink?: (record: ResolveNodeTrace) => void
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
	score: number
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
			| "postcode_prefix"
			| "postcode_format_probe"
			| "empty_admin"
			| "span_rescore"
			| "postal_compound_recovery"
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
	/**
	 * Optional list of missing backend capabilities.
	 */
	capabilityGaps: readonly BackendCapabilityGap[] | null
}
