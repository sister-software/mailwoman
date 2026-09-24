/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Dependency-free interfaces for the runtime pipeline and its injected stages.
 */

import type { AddressTree } from "#decoder/types"
import type { MachinePreferences } from "#pipeline/preferences"
import type { ResolveOpts, Resolver, ResolverBackend } from "#resolver/types"
import type { Section } from "#types/classifier"

export { type PipelineFault, type PipelineResult } from "#pipeline/result"
export { type MachinePreferences } from "#pipeline/preferences"

/**
 * Optional user-location input for resolver scoring.
 */
export type UserLocation = { lat: number; lon: number } | { country: string } | { region: string; country: string }

/**
 * Opaque placetype-pair prior passed through to the classifier.
 * Core does not inspect it.
 */
export type PlacetypePairPassthrough = object | false

/**
 * Options passed through pipeline stages.
 */
export interface PipelineOpts {
	locale?: Intl.UnicodeBCP47LocaleIdentifier
	userLocation?: UserLocation
	/**
	 * Input register.
	 * Defaults from the query kind when unset.
	 */
	inputMode?: InputMode
	/**
	 * Disable fast paths.
	 * POI routing is unaffected.
	 */
	forceFullPipeline?: boolean
	/**
	 * Resolver lookup limit, passed through unchanged.
	 */
	resolveOpts?: ResolveOpts
	/**
	 * Normalize detected all-caps ASCII before classification.
	 * Pass `false` to preserve raw case.
	 */
	normalizeCase?: boolean
	/**
	 * Opaque per-parse prior passed to the classifier.
	 * Unset disables it.
	 */
	placetypePair?: PlacetypePairPassthrough
	/**
	 * Allow a confident, coverage-qualified placer result to become a hard country filter.
	 */
	hardPlaceCountry?: boolean
	/**
	 * Override the artifact's country-coverage safelist.
	 */
	hardCountrySafelist?: ReadonlySet<string>
	signal?: AbortSignal
}

/**
 * Minimal normalized-input shape required by the pipeline.
 */
export interface NormalizedInputLite {
	raw: string
	normalized: string
	appliedLocale?: string
}

/**
 * Minimal query-shape data required by the pipeline.
 */
export interface QueryShapeLite {
	knownFormats: ReadonlyArray<{
		format: string
		span: { start: number; end: number }
		confidence: number
	}>
	segments?: ReadonlyArray<{ body: string; index: number }>
	characterClass?: string
	/**
	 * ISO 15924 scripts ranked by share of script-bearing characters.
	 */
	scripts?: ReadonlyArray<{ script: string; share: number }>
	/**
	 * Per-token class and script.
	 * `computeQueryShape` supplies this field.
	 */
	tokenClasses?: ReadonlyArray<{
		span: { start: number; end: number; body: string }
		class: string
		length: number
		script?: string
	}>
	totalLength?: number
}

/**
 * Locale prediction or caller hint, with alternatives.
 */
export interface LocaleHint {
	locale: Intl.UnicodeBCP47LocaleIdentifier
	confidence: number
	alternatives: ReadonlyArray<{ locale: Intl.UnicodeBCP47LocaleIdentifier; confidence: number }>
	source: "caller" | "environment" | "machine" | "detected" | "ensemble"
	/**
	 * ISO 15924 scripts detected in the input, ranked by character share.
	 *
	 * Empty when no script-bearing text is present.
	 * Separate from `locale`, which remains a BCP-47 language tag.
	 */
	script?: ReadonlyArray<{ script: string; confidence: number }>
	/**
	 * Diagnostic provenance for inferred preferences.
	 *
	 * Locale and timezone remain independent signals.
	 */
	evidence?: {
		intlLocale?: string
		timeZone?: string
		environmentLocale?: Intl.UnicodeBCP47LocaleIdentifier
	}
}

/**
 * Query kinds emitted by the classifier.
 */
export type QueryKind =
	| "postcode_only"
	| "locality_only"
	| "structured_address"
	| "intersection"
	| "po_box"
	| "landmark"
	| "poi_query"
	| "vague"
	/**
	 * Intent kinds that describe the requested operation rather than input structure.
	 */
	/**
	 * Bare place name without address components. Used for ambiguity reporting after resolution.
	 */
	| "bare_toponym"
	/**
	 * Two place names without intervening address grammar. Reports both readings without routing.
	 */
	| "route_pair"
	/**
	 * Relative location query that requires the caller's position.
	 */
	| "near_me"
	/**
	 * POI category query without a search anchor.
	 */
	| "poi_category"

/**
 * Advisory codes that report query interpretation or evidence gaps.
 */
export const QueryIntentCode = {
	/**
	 * Resolution found no decisive candidate for a named place.
	 */
	DeclaredAmbiguity: "declared_ambiguity",
	/**
	 * The query has two readings; `evidence.interpretations` names them.
	 */
	DeclaredFork: "declared_fork",
	/**
	 * A relative query lacks its required focus point.
	 */
	FocusPointRequired: "focus_point_required",
	/**
	 * POI category resolved from the query.
	 */
	POICategory: "poi_category",
	/**
	 * No matching feature exists in a cell with exclusion-grade coverage.
	 */
	CoverageQualifiedAbsence: "coverage_qualified_absence",
	/**
	 * An authority's designation for the resolved coordinate, supported by its coverage record.
	 */
	AuthorityDesignation: "authority_designation",
	/**
	 * The resolved result is coarser than the parsed address.
	 * Evidence names unused components and both tiers.
	 */
	DeclaredCoarserAnswer: "declared_coarser_answer",
} as const

export type QueryIntentCode = (typeof QueryIntentCode)[keyof typeof QueryIntentCode]

/**
 * Advisory emitted by query-intent logic.
 * It does not change the selected answer.
 */
export interface QueryIntentMarker {
	/**
	 * Kind that produced the marker; it must appear in the classifier result.
	 */
	kind: QueryKind
	code: QueryIntentCode
	/**
	 * `family:rule` identifier for the producer.
	 */
	mechanism: string
	/**
	 * Display text.
	 * Use `code` for stable branching.
	 */
	message: string
	/**
	 * Supporting measurement, when available.
	 */
	evidence?: Record<string, unknown>
}

export interface QueryKindResult {
	kind: QueryKind
	confidence: number
	alternatives: ReadonlyArray<{ kind: QueryKind; confidence: number }>
	/**
	 * Optional advisories raised during kind classification.
	 */
	intentMarkers?: ReadonlyArray<QueryIntentMarker>
}

/**
 * Parse register: `fragmented` for search input and `formatted` for complete postal records.
 *
 * When unset, {@link deriveInputMode} derives it from query kind.
 */
export type InputMode = "fragmented" | "formatted"

/**
 * Map complete-address kinds to `formatted`; map all other kinds to `fragmented`.
 */
export function deriveInputMode(kind: QueryKind): InputMode {
	switch (kind) {
		case "structured_address":
		case "po_box":
		case "intersection":
			return "formatted"
		default:
			return "fragmented"
	}
}

/**
 * Structured POI query passed from classification to search executors.
 */
export interface POIIntent {
	subject:
		| {
				kind: "category"
				/**
				 * Category IDs to search together.
				 * Array order does not indicate rank.
				 */
				categoryIDs: string[]
				matched: string
				/**
				 * Categories excluded by the resolved anchor country.
				 */
				countryBinding?: { anchorCountry: string | null; excludedCategoryIDs: string[] }
		  }
		| { kind: "brand"; name: string; wikidata?: string; matched: string }
		| { kind: "name"; text: string }
	/**
	 * Relation between the subject and anchor.
	 */
	relation?: "comma" | "near" | "in" | "at" | "around" | "to"
	/**
	 * Parsed spatial anchor, when present.
	 */
	anchor?: {
		text?: string
		tree?: AddressTree
		/**
		 * Caller-supplied location used when no anchor tree is available.
		 */
		biasPoint?: { latitude: number; longitude: number }
		radiusM?: number
	}
	limit?: number
}

/**
 * One POI search result.
 */
export interface POIResult {
	name: string | null
	categoryID: string | null
	brandWikidata: string | null
	latitude: number
	longitude: number
	country: string
	confidence: number
	/**
	 * Overture GERS ID, included as metadata.
	 */
	gersID: string | null
	/**
	 * WOF ancestry, deepest first.
	 * Omitted when no reverse geocoder is configured.
	 */
	ancestry?: ReadonlyArray<{ placetype: string; name: string; wofID: number }>
	distanceM?: number
}

/**
 * Result of POI handling, or an abstention when the query cannot be answered.
 */
export type POIIntentOutcome =
	| { type: "intent"; intent: POIIntent; results?: POIResult[] }
	| { type: "abstain"; reason: string }

/**
 * Structural phrase shapes proposed before classification.
 * The classifier assigns component tags.
 */
export type PhraseKind =
	| "NUMERIC"
	| "STREET_PHRASE"
	| "LOCALITY_PHRASE"
	| "REGION_ABBREVIATION"
	| "POSTCODE"
	| "VENUE_PHRASE"
	| "HYPHENATED_COMPOUND"

/**
 * Structural phrase proposal with span, kind hypothesis, and confidence.
 */
export interface PhraseProposal {
	span: Section
	kindHypothesis: PhraseKind
	confidence: number
}

/**
 * Interface for a phrase grouper.
 */
export interface PhraseGrouper {
	group(input: NormalizedInputLite, shape: QueryShapeLite, locale: LocaleHint): Promise<PhraseProposal[]>
}

/**
 * Interface for a classifier that converts text to an address tree.
 */
/**
 * Structural interface for an FST gazetteer matcher.
 */
export interface FSTMatcherLike {
	walk(tokens: string[]): { stateID: number; accepted: boolean; depth: number } | null
	walkFrom(
		prev: { stateID: number; depth: number },
		token: string
	): { stateID: number; accepted: boolean; depth: number } | null
	accepting(stateID: number): Array<{ wofID: number; placetype: string; referential: number }>
}

export interface ClassifierOpts {
	queryShape?: QueryShapeLite
	/**
	 * Input register passed to the classifier.
	 */
	inputMode?: InputMode
	fst?: FSTMatcherLike
	fstBiasScale?: number
	/**
	 * Street-morphology matcher used by the street-context check.
	 * The pipeline disables its emission prior.
	 */
	fstStreetMorphology?: FSTMatcherLike
	/**
	 * Emission-prior settings for the morphology matcher.
	 */
	fstStreetMorphologyOpts?: { biasScale?: number; dependentLocalityPenalty?: number }
	/**
	 * Apply deterministic postcode repair after decoding.
	 */
	postcodeRepair?: boolean
	/**
	 * Title-case detected all-caps ASCII input before classification.
	 * Set `false` to preserve raw case.
	 */
	normalizeCase?: boolean
	/**
	 * Resolve BIO tag disagreement among pieces within one word.
	 */
	enforceWordConsistency?:
		| boolean
		| { minMeanConfidence?: number; skipByteFallbackWords?: boolean; splitOnPunctuation?: boolean }
	/**
	 * Opaque placetype-pair prior passed through to the classifier.
	 */
	placetypePair?: PlacetypePairPassthrough
}

/**
 * Production word-consistency settings, shared by runtime and evaluation paths.
 */
export const WORD_CONSISTENCY_SHIP_DEFAULT = {
	skipByteFallbackWords: true,
	splitOnPunctuation: true,
} as const satisfies ClassifierOpts["enforceWordConsistency"]

export interface AddressClassifier {
	parse(text: string, opts?: ClassifierOpts): Promise<AddressTree>
}

/**
 * Locale detector interface.
 *
 * Caller hints take precedence over environment and machine preferences.
 */
export type LocaleDetector = (
	input: NormalizedInputLite,
	shape: QueryShapeLite,
	opts?: {
		hint?: Intl.UnicodeBCP47LocaleIdentifier
		machinePreferences?: MachinePreferences
		environmentLocale?: Intl.UnicodeBCP47LocaleIdentifier
	}
) => Promise<LocaleHint>

/**
 * Optional stage implementations composed by the runtime pipeline.
 */
export interface RuntimePipelineStages {
	normalize?: (raw: string, opts?: { locale?: string }) => NormalizedInputLite
	computeQueryShape?: (input: NormalizedInputLite | string, opts?: { locale?: string }) => QueryShapeLite
	detectLocale?: LocaleDetector
	classifyKind?: (input: NormalizedInputLite, shape: QueryShapeLite, locale: LocaleHint) => Promise<QueryKindResult>
	/**
	 * Optional country placer.
	 *
	 * Confident in-map predictions become a soft resolver prior; abstentions
	 * and off-map results add no signal.
	 * An optional posterior supplies the full country distribution.
	 */
	placeCountry?: (normalizedText: string) => {
		country: string | null
		confidence: number
		posterior?: Record<string, number>
	}
	/**
	 * Optional POI handler.
	 * A `null` result falls through to the full parse pipeline.
	 */
	poiIntent?: (input: NormalizedInputLite, locale: LocaleHint, opts?: PipelineOpts) => Promise<POIIntentOutcome | null>
	/**
	 * Optional phrase grouper whose proposals are returned and used by later stages.
	 */
	groupPhrases?: (input: NormalizedInputLite, shape: QueryShapeLite, locale: LocaleHint) => Promise<PhraseProposal[]>
	classifier?: AddressClassifier
	/**
	 * Optional FST matcher used to add gazetteer emission biases.
	 */
	fst?: FSTMatcherLike
	/**
	 * Optional street-morphology matcher, used with `fst` for the street-context check.
	 */
	streetMorphology?: FSTMatcherLike
	resolver?: Resolver
	/**
	 * Optional backend for resolver candidate and parent-chain lookups during reconciliation.
	 */
	resolverBackend?: ResolverBackend
}

export type PipelineTiming = Record<string, number>

/**
 * Stages whose failures are recorded while the pipeline continues.
 */
export const PipelineFaultStage = {
	Classifier: "classifier",
	PhraseGrouper: "phrase-grouper",
	Resolver: "resolver",
} as const

export type PipelineFaultStage = (typeof PipelineFaultStage)[keyof typeof PipelineFaultStage]
