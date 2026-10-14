/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	type CaseNormalization,
	type PlacerCountryUse,
	type FSTMatcherLike,
	type LocaleHint,
	runPipeline,
	type StageSource,
	type MachinePreferences,
	type PipelineOpts,
	type PipelineResult,
	type POIIntent,
	type POIQueryResult,
	type RuntimePipelineStages,
	type VenueHeadLexiconLike,
} from "@mailwoman/core/pipeline"
import type { WOFAncestor } from "@mailwoman/core/resolver"
import {
	classifyKind as defaultClassifyKind,
	createKindClassifier,
	type POIPhraseLookup,
} from "@mailwoman/kind-classifier"
import { detectLocale } from "@mailwoman/locale-hint"
import { type NeuralAddressClassifier, type ParseOpts, scriptFamilyForText } from "@mailwoman/neural"
import { normalize } from "@mailwoman/normalize"
import { groupPhrases as defaultGroupPhrases } from "@mailwoman/phrase-grouper"
import { getPOICategory, requiresBuildLocalLayer, resolveOvertureCategories } from "@mailwoman/poi-taxonomy"
import { venueHeadLexicon } from "@mailwoman/poi-taxonomy/venue-heads"
import { computeQueryShape } from "@mailwoman/query-shape"
import type { StreetLocalityEvidence } from "@mailwoman/resolver"
import { resolvePath, type PathBuilderLike } from "path-ts"

import { localeToCountry } from "#country-scope"
import { loadDefaultPlaceCountry } from "#default/placer"
import { loadDefaultReverseGeocoder } from "#default/reverse-geocoder"
import { loadDefaultStreetEvidence } from "#default/street-evidence"
import { $public } from "#env"
import { loadParsePriors, type ParsePriorArtifacts } from "#geocode/parse-priors"
import { rerankByStreetEvidence } from "#kbest-street-rerank"
import { createPOIExecutor } from "#poi/executor"
import { createPOIIntentStage, createPOINameLookup, poiTaxonomyLookup } from "#poi/intent"
import { stampSpanScripts } from "#span-script"

interface ReverseGeocoderLike {
	reverseGeocodeSync(
		latitude: number,
		longitude: number
	): { hierarchy: ReadonlyArray<{ id: number; name: string; placetype: string }> }
}

function buildSyncReverseGeocode(
	geocoder: ReverseGeocoderLike
): (latitude: number, longitude: number) => ReadonlyArray<WOFAncestor> | null {
	return (latitude, longitude) => {
		try {
			const { hierarchy } = geocoder.reverseGeocodeSync(latitude, longitude)

			if (!hierarchy.length) return null

			return hierarchy.map((place) => ({ placetype: place.placetype, name: place.name, wofID: place.id }))
		} catch {
			return null
		}
	}
}

/**
 * How {@link createRuntimePipeline} handles POI queries.
 *
 * - `"extract"` detects POI queries and extracts intents without executing them.
 * - `"none"` removes the POI stage.
 * - `{ poiDatabasePath }` also executes intents against a lookup opened on the first call.
 */
export type POIQueryKindSetting = "extract" | "none" | { poiDatabasePath: PathBuilderLike }

/**
 * Options for {@link createRuntimePipeline}.
 *
 * `machinePreferences`, `placeCountry`, `streetEvidence`, `fst` and `streetMorphology`
 * take a {@link StageSource} and default to `"auto"`.
 */
export interface CreateRuntimePipelineOpts {
	/**
	 * Host locale preferences, used only when neither the caller nor the input identifies a locale.
	 *
	 * `"auto"` reads the current `Intl` defaults and `"none"` disables host inference.
	 * `MW_LOCALE` overrides both.
	 */
	machinePreferences?: StageSource<MachinePreferences>

	/**
	 * The classification stage, typically a `NeuralAddressClassifier`.
	 */
	classifier?: RuntimePipelineStages["classifier"]

	/**
	 * The resolution stage, typically a `WOFResolver` from `@mailwoman/resolver-wof-sqlite`.
	 */
	resolver?: RuntimePipelineStages["resolver"]

	/**
	 * The FST gazetteer matcher that biases emissions during classification.
	 *
	 * `"auto"` loads the classifier's `fstPath` if one exists.
	 */
	fst?: StageSource<FSTMatcherLike>

	/**
	 * The street-morphology matcher for the FST street-context check.
	 *
	 * `"auto"` loads the sealed artifact, or builds one from the bundled dictionaries,
	 * when an FST matcher is active.
	 */
	streetMorphology?: StageSource<FSTMatcherLike>

	/**
	 * Whether the street-morphology matcher also biases a street affix on a segment that
	 * opens with a house number, as `Plaza` in `30 Rockefeller Plaza, New York, NY 10112`.
	 *
	 * The default is the geocode session's.
	 *
	 * @defaultValue `true`
	 */
	streetMorphologyPrior?: boolean

	/**
	 * The venue-head lexicon for each parse's detected locale.
	 *
	 * `"auto"` reads the bundled table for the locale's country, and `"none"` runs no venue-head prior.
	 */
	venueHead?: StageSource<NonNullable<RuntimePipelineStages["venueHead"]>>

	/**
	 * A replacement for the default locale detector.
	 *
	 * It combines input structure, `MW_LOCALE` and machine preferences.
	 */
	detectLocale?: RuntimePipelineStages["detectLocale"]

	/**
	 * A replacement for the default kind classifier, including the POI-aware one from `poiQueryKind`.
	 */
	classifyKind?: RuntimePipelineStages["classifyKind"]

	/**
	 * A replacement for the default rule-based phrase grouper.
	 */
	groupPhrases?: RuntimePipelineStages["groupPhrases"]

	/**
	 * The coarse country placer.
	 *
	 * Its confident guess becomes a soft country prior for the resolver.
	 */
	placeCountry?: StageSource<NonNullable<RuntimePipelineStages["placeCountry"]>>

	/**
	 * The default for each call's `caseNormalization`.
	 *
	 * A per-call value overrides it.
	 *
	 * @defaultValue `"title-case"`
	 */
	caseNormalization?: CaseNormalization

	/**
	 * The default for each call's `placerCountryUse`.
	 *
	 * A per-call value overrides it.
	 *
	 * @defaultValue `"filter"`
	 */
	placerCountryUse?: PlacerCountryUse

	/**
	 * The default for each call's `hardCountrySafelist`.
	 *
	 * When it is unset, the resolver artifact's safelist applies, then `HARD_PLACE_COUNTRY_SAFELIST`.
	 */
	hardCountrySafelist?: ReadonlySet<string>

	/**
	 * The street-name index for the classifier's k-best street rerank.
	 *
	 * The rerank can add a confirmed street but never removes one.
	 *
	 * `"auto"` loads the bundled French index on the first call when the classifier has a span grammar.
	 */
	streetEvidence?: StageSource<StreetLocalityEvidence>

	/**
	 * Controls POI-query detection and intent extraction.
	 *
	 * @defaultValue `"extract"`
	 */
	poiQueryKind?: POIQueryKindSetting

	/**
	 * A fallback phrase lookup, consulted only when the category lexicon and the POI name lookup both miss.
	 */
	poiSemanticLookup?: POIPhraseLookup
}

function wrapWithStreetEvidence(
	classifier: RuntimePipelineStages["classifier"],
	evidence: StreetLocalityEvidence | null
): RuntimePipelineStages["classifier"] {
	if (!classifier || !evidence) return classifier
	const grammar = (classifier as Partial<NeuralAddressClassifier>).spanGrammar

	if (!grammar) return classifier
	const inner = classifier as NeuralAddressClassifier

	return {
		parse: async (text, cOpts) =>
			(await rerankByStreetEvidence(inner, text, evidence, grammar, { parseOpts: cOpts as ParseOpts | undefined }))
				.tree,
	}
}

/**
 * Returns the prior artifact paths a classifier exposes.
 *
 * A bare `{ parse }` classifier exposes none, and the pipeline then parses without the FST priors.
 */
function classifierPriorArtifacts(classifier: CreateRuntimePipelineOpts["classifier"]): ParsePriorArtifacts {
	if (!classifier || typeof classifier !== "object") return {}

	const shaped = classifier as { fstPath?: PathBuilderLike | null; streetMorphologyPath?: string | null }

	return {
		...("fstPath" in shaped ? { fstPath: shaped.fstPath } : {}),
		...("streetMorphologyPath" in shaped ? { streetMorphologyPath: shaped.streetMorphologyPath } : {}),
	}
}

/**
 * The venue-head stage that reads the bundled table for the detected locale's country.
 */
function venueHeadForLocale(locale: LocaleHint): VenueHeadLexiconLike {
	return venueHeadLexicon(localeToCountry(locale.locale) ?? "")
}

/**
 * Returns the host's locale and time zone from `Intl`, or an empty object when `Intl` fails.
 */
export function getMachinePreferences(): MachinePreferences {
	try {
		const { locale, timeZone } = Intl.DateTimeFormat().resolvedOptions()

		return {
			...(locale ? { locale } : {}),
			...(timeZone ? { timeZone } : {}),
		}
	} catch {
		return {}
	}
}

/**
 * Creates a production parse function that runs the full pipeline with the given stages.
 *
 * Omitted stages use bundled defaults that load on the first call.
 * The placer country use is `"filter"` unless the options or the call choose otherwise.
 */
export function createRuntimePipeline(
	opts: CreateRuntimePipelineOpts = {}
): (raw: string, runOpts?: PipelineOpts) => Promise<PipelineResult> {
	const poiQueryKind = opts.poiQueryKind ?? "extract"
	const poiQueryKindEffective = poiQueryKind !== "none"
	const machinePreferencesSource = opts.machinePreferences ?? "auto"
	const fstSource = opts.fst ?? "auto"
	const streetMorphologySource = opts.streetMorphology ?? "auto"
	const venueHeadSource = opts.venueHead ?? "none"
	const placeCountrySource = opts.placeCountry ?? "auto"
	const streetEvidenceSource = opts.streetEvidence ?? "auto"

	const machinePreferences =
		machinePreferencesSource === "none"
			? null
			: machinePreferencesSource === "auto"
				? getMachinePreferences()
				: machinePreferencesSource

	let poiNameLookup: POIPhraseLookup | null = null

	const poiSubjectLookup: POIPhraseLookup = (phrase, locale) => {
		const lexical = poiTaxonomyLookup(phrase, locale)

		if (lexical.length) return lexical

		const named = poiNameLookup?.(phrase, locale) ?? []

		if (named.length) return named

		return opts.poiSemanticLookup?.(phrase, locale) ?? []
	}

	const classifierShape = opts.classifier as { encoder?: string; forInput?: unknown } | undefined

	const keepPostalMark = (raw: string): boolean =>
		classifierShape?.encoder === "char" || (!!classifierShape?.forInput && scriptFamilyForText(raw) === "cjk")

	const stages: RuntimePipelineStages = {
		normalize: (raw, normalizeOpts) =>
			normalize(raw, { ...normalizeOpts, ...(keepPostalMark(raw) ? { postalMark: "keep" } : {}) }),
		computeQueryShape,

		classifyKind:
			opts.classifyKind ??
			(poiQueryKindEffective ? createKindClassifier({ poiLexicon: poiSubjectLookup }) : defaultClassifyKind),

		groupPhrases: opts.groupPhrases ?? defaultGroupPhrases,

		classifier:
			typeof streetEvidenceSource === "object"
				? wrapWithStreetEvidence(opts.classifier, streetEvidenceSource)
				: opts.classifier,

		...(typeof fstSource === "object" ? { fst: fstSource } : {}),
		...(typeof streetMorphologySource === "object" ? { streetMorphology: streetMorphologySource } : {}),
		streetMorphologyPrior: opts.streetMorphologyPrior ?? true,
		...(venueHeadSource === "auto"
			? { venueHead: venueHeadForLocale }
			: venueHeadSource === "none"
				? {}
				: { venueHead: venueHeadSource }),
		...(opts.resolver ? { resolver: opts.resolver } : {}),

		...(typeof placeCountrySource === "function" ? { placeCountry: placeCountrySource } : {}),

		detectLocale:
			opts.detectLocale ??
			(async (_input, shape, detectOpts) =>
				detectLocale(shape, {
					...detectOpts,
					...($public.MW_LOCALE ? { environmentLocale: $public.MW_LOCALE } : {}),
					...(machinePreferences ? { machinePreferences } : {}),
				})),
	}

	const requiresBuildLocal = (categoryID: string): boolean => {
		const category = getPOICategory(categoryID)

		return category ? requiresBuildLocalLayer(category) : false
	}

	let poiExecute: ((intent: POIIntent) => POIQueryResult) | null = poiQueryKindEffective
		? createPOIExecutor({ lookup: null, requiresBuildLocal, resolveOvertureCategories })
		: null

	if (poiQueryKindEffective) {
		stages.poiIntent = createPOIIntentStage({
			lookup: poiSubjectLookup,

			parseAnchor: (text, runOpts) =>
				runPipeline(text, { ...stages, classifyKind: defaultClassifyKind, poiIntent: undefined }, runOpts),

			execute: (intent) => poiExecute!(intent),
		})
	}

	let placeCountryResolved = placeCountrySource !== "auto"
	let streetEvidenceResolved = streetEvidenceSource !== "auto"
	let priorsResolved = fstSource !== "auto" && streetMorphologySource !== "auto"

	const poiDatabasePath = typeof poiQueryKind === "object" ? poiQueryKind.poiDatabasePath : null
	let poiLookupResolved = !poiDatabasePath

	return async (raw: string, runOpts?: PipelineOpts): Promise<PipelineResult> => {
		if (!placeCountryResolved) {
			placeCountryResolved = true
			const fn = await loadDefaultPlaceCountry()

			if (fn) {
				stages.placeCountry = fn
			}
		}

		if (!poiLookupResolved && poiDatabasePath) {
			poiLookupResolved = true

			try {
				const { POILookup } = await import("@mailwoman/resolver-wof-sqlite/poi")

				const reverseGeocoder = await loadDefaultReverseGeocoder()

				const lookup = new POILookup({ databasePath: resolvePath(poiDatabasePath) })
				poiNameLookup = createPOINameLookup(lookup)

				poiExecute = createPOIExecutor({
					lookup,
					requiresBuildLocal,
					resolveOvertureCategories,
					...(reverseGeocoder ? { reverseGeocode: buildSyncReverseGeocode(reverseGeocoder) } : {}),
				})
			} catch {}
		}

		if (!streetEvidenceResolved) {
			streetEvidenceResolved = true
			const grammar = (opts.classifier as Partial<NeuralAddressClassifier> | undefined)?.spanGrammar

			if (grammar) {
				const evidence = await loadDefaultStreetEvidence()

				if (evidence) {
					stages.classifier = wrapWithStreetEvidence(opts.classifier, evidence)
				}
			}
		}

		if (!priorsResolved) {
			priorsResolved = true
			const artifacts = classifierPriorArtifacts(opts.classifier)

			// A classifier without an FST artifact parses without the FST priors, as it did
			// before the loader, so a bare classifier raises no warning.
			const loaded = await loadParsePriors(artifacts, {
				gazetteerPrior: Boolean(stages.fst) || (fstSource === "auto" && Boolean(artifacts.fstPath)),
				...(stages.fst ? { fst: stages.fst } : {}),
				venueHeadPrior: false,
			})

			if (fstSource === "auto" && loaded.fst) {
				stages.fst = loaded.fst
			}

			if (streetMorphologySource === "auto" && loaded.streetMorphology) {
				stages.streetMorphology = loaded.streetMorphology
			}
		}

		let effectiveRunOpts = runOpts

		if (opts.caseNormalization && !effectiveRunOpts?.caseNormalization) {
			effectiveRunOpts = { ...effectiveRunOpts, caseNormalization: opts.caseNormalization }
		}

		if (opts.placerCountryUse && !effectiveRunOpts?.placerCountryUse) {
			effectiveRunOpts = { ...effectiveRunOpts, placerCountryUse: opts.placerCountryUse }
		}

		if (opts.hardCountrySafelist && !effectiveRunOpts?.hardCountrySafelist) {
			effectiveRunOpts = { ...effectiveRunOpts, hardCountrySafelist: opts.hardCountrySafelist }
		}

		const result = await runPipeline(raw, stages, effectiveRunOpts)

		stampSpanScripts(result.tree, result.normalized.normalized)

		return result
	}
}
