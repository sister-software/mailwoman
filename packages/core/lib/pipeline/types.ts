/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Declares the types for the runtime pipeline and its injected stages.
 */

import type { NormalizedInputLite } from "@mailwoman/query-shape"
import { z } from "zod"

import { type AddressTree, AddressTreeSchema } from "#decoder/types"
import type { MachinePreferences } from "#pipeline/preferences"
import type { ResolveOpts, Resolver, ResolverBackend } from "#resolver/types"
import type { Section } from "#types/classifier"

export { type PipelineFault, type PipelineResult } from "#pipeline/result"
export { type MachinePreferences } from "#pipeline/preferences"

/**
 * The user's location.
 * The resolver may use it for scoring.
 */
export type UserLocation = { lat: number; lon: number } | { country: string } | { region: string; country: string }

/**
 * A placetype-pair prior that core passes to the classifier without inspecting it.
 */
export type PlacetypePairPassthrough = object | false | null

/**
 * Per-call options for the runtime pipeline.
 */
export interface PipelineOpts {
	locale?: Intl.UnicodeBCP47LocaleIdentifier
	userLocation?: UserLocation
	/**
	 * The input register.
	 * When unset, the pipeline derives it from the query kind.
	 */
	inputMode?: InputMode
	/**
	 * Disables the postcode and locality fast paths.
	 * POI routing still applies.
	 */
	forceFullPipeline?: boolean
	/**
	 * Options passed to the resolver.
	 * The coarse placer may add a country prior to them.
	 */
	resolveOpts?: ResolveOpts
	/**
	 * Normalizes all-caps ASCII input before classification.
	 * Pass `false` to keep the raw case.
	 */
	normalizeCase?: boolean
	/**
	 * A per-parse placetype-pair prior for the classifier.
	 * An unset value disables the prior.
	 */
	placetypePair?: PlacetypePairPassthrough
	/**
	 * Allows a confident placer result for a safelisted country to become a hard country filter.
	 */
	hardPlaceCountry?: boolean
	/**
	 * Replaces the artifact's hard-country safelist.
	 */
	hardCountrySafelist?: ReadonlySet<string>
	signal?: AbortSignal
}

/**
 * The fields of a query shape that the pipeline reads.
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
	 * The class and script of each token.
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
 * A locale from detection or a caller hint, with alternatives.
 */
export interface LocaleHint {
	locale: Intl.UnicodeBCP47LocaleIdentifier
	confidence: number
	alternatives: ReadonlyArray<{ locale: Intl.UnicodeBCP47LocaleIdentifier; confidence: number }>
	source: "caller" | "environment" | "machine" | "detected" | "ensemble"
	/**
	 * ISO 15924 scripts in the input, ranked by character share.
	 *
	 * The array is empty when the input has no script-bearing text.
	 * `locale` stays a BCP-47 language tag.
	 */
	script?: ReadonlyArray<{ script: string; confidence: number }>
	/**
	 * Diagnostic values that fed the inferred preferences.
	 * Locale and time zone are independent signals.
	 */
	evidence?: {
		intlLocale?: string
		timeZone?: string
		environmentLocale?: Intl.UnicodeBCP47LocaleIdentifier
	}
}

/**
 * The query kinds the kind classifier emits.
 *
 * The last four kinds describe the requested operation instead of the input's structure:
 *
 * - `bare_toponym`: a bare place name with no address components.
 *   Resolution uses it to report ambiguity.
 * - `route_pair`: two place names with no address grammar between them.
 *   The pipeline reports both readings and does no routing.
 * - `near_me`: a relative location query that needs the caller's position.
 * - `poi_category`: a POI category query with no search anchor.
 */
export const QueryKindSchema = z
	.enum([
		"postcode_only",
		"locality_only",
		"structured_address",
		"intersection",
		"po_box",
		"landmark",
		"poi_query",
		"vague",
		"bare_toponym",
		"route_pair",
		"near_me",
		"poi_category",
	])
	.meta({ id: "QueryKind", description: "The query kind the kind classifier assigned." })

export type QueryKind = z.infer<typeof QueryKindSchema>

/**
 * Advisory codes that report how a query was interpreted or what evidence is missing.
 */
export const QueryIntentCode = {
	/**
	 * Resolution found no decisive candidate for a place with a recognized name.
	 */
	DeclaredAmbiguity: "declared_ambiguity",
	/**
	 * The query has two readings, listed in `evidence.interpretations`.
	 */
	DeclaredFork: "declared_fork",
	/**
	 * A relative query lacks the focus point it needs.
	 */
	FocusPointRequired: "focus_point_required",
	/**
	 * The query resolved to a POI category.
	 */
	POICategory: "poi_category",
	/**
	 * No matching feature exists in a cell whose coverage is complete enough to rule it out.
	 */
	CoverageQualifiedAbsence: "coverage_qualified_absence",
	/**
	 * An authority's designation for the resolved coordinate, backed by the authority's coverage record.
	 */
	AuthorityDesignation: "authority_designation",
	/**
	 * The resolved result is coarser than the parsed address.
	 * The evidence lists the unused components and both tiers.
	 */
	DeclaredCoarserAnswer: "declared_coarser_answer",
} as const

/**
 * {@link QueryIntentCode} as a schema.
 */
export const QueryIntentCodeSchema = z.enum(QueryIntentCode).meta({ id: "QueryIntentCode" })

/**
 * One of the {@link QueryIntentCode} values.
 */
export type QueryIntentCode = z.infer<typeof QueryIntentCodeSchema>

/**
 * An advisory from query-intent logic.
 * It leaves the selected answer unchanged.
 */
export const QueryIntentMarkerSchema = z
	.object({
		/**
		 * The query kind that produced the marker.
		 * It must appear in the classifier result.
		 */
		kind: QueryKindSchema,
		code: QueryIntentCodeSchema,
		/**
		 * A `family:rule` identifier for the producer.
		 */
		mechanism: z.string(),
		/**
		 * Human-readable text.
		 * Branch on `code`, which is stable.
		 */
		message: z.string(),
		/**
		 * Measurements from supporting sources, when available.
		 *
		 * Each `code` has its own measurement, so the record stays open.
		 */
		evidence: z.record(z.string(), z.unknown()).optional(),
	})
	.meta({ id: "QueryIntentMarker", description: "A query-intent advisory; it never changes the answer." })

export type QueryIntentMarker = z.infer<typeof QueryIntentMarkerSchema>

/**
 * The kind classifier's result.
 */
export interface QueryKindResult {
	kind: QueryKind
	confidence: number
	alternatives: ReadonlyArray<{ kind: QueryKind; confidence: number }>
	/**
	 * Advisories raised during kind classification.
	 */
	intentMarkers: ReadonlyArray<QueryIntentMarker> | null
}

/**
 * The parse register.
 *
 * `fragmented` suits search input and `formatted` suits complete postal records.
 *
 * When unset, {@link deriveInputMode} derives it from the query kind.
 */
export const InputModeSchema = z
	.enum(["fragmented", "formatted"])
	.meta({ id: "InputMode", description: "The parse register; unset derives it from the input's shape." })

export type InputMode = z.infer<typeof InputModeSchema>

/**
 * Maps complete-address kinds to `formatted` and every other kind to `fragmented`.
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
 * The relation between a POI subject and its anchor, as the query phrased it.
 */
export const POISpatialRelationSchema = z.enum(["comma", "near", "in", "at", "around", "to"])

export type POISpatialRelation = z.infer<typeof POISpatialRelationSchema>

const POICategorySubjectSchema = z.object({
	kind: z.literal("category"),
	/**
	 * Category IDs to search together.
	 * The order does not rank these values.
	 */
	categoryIDs: z.array(z.string()),
	matched: z.string(),
	/**
	 * Categories that the resolved anchor country excludes.
	 */
	countryBinding: z
		.object({ anchorCountry: z.string().nullable(), excludedCategoryIDs: z.array(z.string()) })
		.optional(),
})

const POIBrandSubjectSchema = z.object({
	kind: z.literal("brand"),
	name: z.string(),
	wikidata: z.string().optional(),
	matched: z.string(),
})

const POINameSubjectSchema = z.object({ kind: z.literal("name"), text: z.string() })

/**
 * The parsed spatial anchor of a POI query.
 */
const POIAnchorSchema = z.object({
	text: z.string().optional(),
	tree: AddressTreeSchema.optional(),
	/**
	 * A caller-supplied location, used when no anchor tree is available.
	 */
	biasPoint: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
	radiusM: z.number().optional(),
})

/**
 * A structured POI query that classification hands to search executors.
 */
export const POIIntentSchema = z
	.object({
		subject: z.discriminatedUnion("kind", [POICategorySubjectSchema, POIBrandSubjectSchema, POINameSubjectSchema]),
		/**
		 * The relation between the subject and the anchor.
		 */
		relation: POISpatialRelationSchema.optional(),
		/**
		 * The parsed spatial anchor, when the query has one.
		 */
		anchor: POIAnchorSchema.optional(),
		limit: z.number().optional(),
	})
	.meta({ id: "POIIntent", description: "A structured POI query." })

export type POIIntent = z.infer<typeof POIIntentSchema>

/**
 * One POI search result.
 */
export const POIResultSchema = z
	.object({
		name: z.string().nullable(),
		categoryID: z.string().nullable(),
		brandWikidata: z.string().nullable(),
		latitude: z.number(),
		longitude: z.number(),
		country: z.string(),
		confidence: z.number(),
		/**
		 * The Overture GERS ID.
		 */
		gersID: z.string().nullable(),
		/**
		 * WOF ancestry, deepest first.
		 * It is absent when no reverse geocoder is configured.
		 */
		ancestry: z
			.array(z.object({ placetype: z.string(), name: z.string(), wofID: z.number() }))
			.readonly()
			.optional(),
		distanceM: z.number().optional(),
	})
	.meta({ id: "POIResult", description: "One POI search result." })

export type POIResult = z.infer<typeof POIResultSchema>

/**
 * The result of POI handling: an intent with optional results, or an abstention with a reason.
 */
export const POIQueryResultSchema = z
	.discriminatedUnion("type", [
		z.object({ type: z.literal("intent"), intent: POIIntentSchema, results: z.array(POIResultSchema).optional() }),
		z.object({ type: z.literal("abstain"), reason: z.string() }),
	])
	.meta({ id: "POIQueryResult", description: "A POI intent with its results, or an abstention." })

export type POIQueryResult = z.infer<typeof POIQueryResultSchema>

/**
 * Structural phrase shapes that the phrase grouper proposes before classification.
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
 * A phrase grouper's proposal for one span.
 */
export interface PhraseProposal {
	span: Section
	kindHypothesis: PhraseKind
	confidence: number
}

/**
 * A stage that groups input tokens into phrase proposals.
 */
export interface PhraseGrouper {
	group(input: NormalizedInputLite, shape: QueryShapeLite, locale: LocaleHint): Promise<PhraseProposal[]>
}

/**
 * The methods the pipeline calls on an FST gazetteer matcher.
 */
export interface FSTMatcherLike {
	walk(tokens: string[]): { stateID: number; accepted: boolean; depth: number } | null
	walkFrom(
		prev: { stateID: number; depth: number },
		token: string
	): { stateID: number; accepted: boolean; depth: number } | null
	accepting(stateID: number): Array<{ wofID: number; placetype: string; referential: number }>
}

/**
 * Options for {@link AddressClassifier.parse}.
 */
export interface ClassifierOpts {
	queryShape?: QueryShapeLite
	inputMode?: InputMode
	fst?: FSTMatcherLike | null
	fstBiasScale?: number
	/**
	 * The street-morphology matcher for the street-context check.
	 * The pipeline sets its emission weights to zero.
	 */
	fstStreetMorphology?: FSTMatcherLike
	/**
	 * Emission-prior weights for the street-morphology matcher.
	 */
	fstStreetMorphologyOpts?: { biasScale?: number; dependentLocalityPenalty?: number }
	/**
	 * Applies deterministic postcode repair after decoding.
	 */
	postcodeRepair?: boolean
	/**
	 * Title-cases all-caps ASCII input before classification.
	 * Set `false` to keep the raw case.
	 */
	normalizeCase?: boolean
	/**
	 * Reconciles differing BIO tags among the pieces of one word.
	 */
	enforceWordConsistency?:
		| boolean
		| { minMeanConfidence?: number; skipByteFallbackWords?: boolean; splitOnPunctuation?: boolean }
	placetypePair?: PlacetypePairPassthrough
}

/**
 * The word-consistency settings that the runtime and evaluation paths both use.
 */
export const WORD_CONSISTENCY_SHIP_DEFAULT = {
	skipByteFallbackWords: true,
	splitOnPunctuation: true,
} as const satisfies ClassifierOpts["enforceWordConsistency"]

/**
 * A classifier that parses text into an address tree.
 */
export interface AddressClassifier {
	parse(text: string, opts?: ClassifierOpts): Promise<AddressTree>
}

/**
 * Detects the input's locale.
 *
 * A caller hint takes precedence over environment and machine preferences.
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
 * The stage implementations that the runtime pipeline composes.
 * Every stage is optional.
 */
export interface RuntimePipelineStages {
	normalize?: (raw: string, opts?: { locale?: string }) => NormalizedInputLite
	computeQueryShape?: (input: NormalizedInputLite | string, opts?: { locale?: string }) => QueryShapeLite
	detectLocale?: LocaleDetector
	classifyKind?: (input: NormalizedInputLite, shape: QueryShapeLite, locale: LocaleHint) => Promise<QueryKindResult>
	/**
	 * The coarse country placer.
	 *
	 * A placed country becomes a resolver prior.
	 * A `null` or `"OTHER"` country adds no prior.
	 *
	 * The optional posterior contains the full country distribution.
	 */
	placeCountry?:
		| null
		| ((normalizedText: string) => {
				country: string | null
				confidence: number
				posterior?: Record<string, number>
		  })
	/**
	 * The POI handler.
	 * A `null` result falls through to the full parse.
	 */
	poiIntent?:
		| null
		| ((input: NormalizedInputLite, locale: LocaleHint, opts?: PipelineOpts) => Promise<POIQueryResult | null>)
	/**
	 * The phrase grouper.
	 *
	 * Its proposals appear in the result and feed the grouper audit.
	 */
	groupPhrases?:
		| null
		| ((input: NormalizedInputLite, shape: QueryShapeLite, locale: LocaleHint) => Promise<PhraseProposal[]>)
	classifier?: AddressClassifier | null
	/**
	 * The FST matcher that adds gazetteer emission biases.
	 */
	fst?: FSTMatcherLike | null
	/**
	 * The street-morphology matcher.
	 * The street-context check runs only when `fst` is also set.
	 */
	streetMorphology?: FSTMatcherLike | null
	resolver?: Resolver | null
	/**
	 * The backend for resolver candidate and parent-chain lookups during reconciliation.
	 */
	resolverBackend?: ResolverBackend | null
}

/**
 * Stage durations in milliseconds, keyed by stage name.
 */
export type PipelineTiming = Record<string, number>

/**
 * The stages whose failures the pipeline records before it continues.
 */
export const PipelineFaultStage = {
	Classifier: "classifier",
	PhraseGrouper: "phrase-grouper",
	Resolver: "resolver",
} as const

/**
 * One of the {@link PipelineFaultStage} values.
 */
export type PipelineFaultStage = (typeof PipelineFaultStage)[keyof typeof PipelineFaultStage]
