/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import {
	type CaseNormalization,
	type PlacerCountryUse,
	type FSTMatcherLike,
	runPipeline,
	type StageSource,
	type MachinePreferences,
	type PipelineOpts,
	type PipelineResult,
	type POIIntent,
	type POIQueryResult,
	type RuntimePipelineStages,
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
import { computeQueryShape } from "@mailwoman/query-shape"
import type { StreetLocalityEvidence } from "@mailwoman/resolver"
import type { FSTMatcher } from "@mailwoman/resolver-wof-sqlite/fst"
import { deserializeFST } from "@mailwoman/resolver-wof-sqlite/fst"
import { loadStreetMorphologyFST } from "@mailwoman/resolver-wof-sqlite/street"
import { resolvePath, type PathBuilderLike } from "path-ts"

import { loadDefaultPlaceCountry } from "#default/placer"
import { loadDefaultReverseGeocoder } from "#default/reverse-geocoder"
import { loadDefaultStreetEvidence } from "#default/street-evidence"
import { $public } from "#env"
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
	 * It defaults to `"title-case"`.
	 * A per-call value overrides it.
	 */
	caseNormalization?: CaseNormalization

	/**
	 * The default for each call's `placerCountryUse`.
	 *
	 * It defaults to `"filter"`.
	 * A per-call value overrides it.
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
	 * It defaults to `"extract"`.
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

async function autoLoadWeightsFST(classifier: CreateRuntimePipelineOpts["classifier"]): Promise<FSTMatcher | null> {
	const fstPath =
		classifier && typeof classifier === "object" && "fstPath" in classifier
			? (classifier as { fstPath?: PathBuilderLike }).fstPath
			: undefined

	if (!fstPath) return null

	try {
		return deserializeFST(await readLocalBuffer(fstPath))
	} catch (error) {
		console.warn(
			`[mailwoman] failed to load weights FST at ${fstPath}: ${(error as Error).message} — parsing without it`
		)

		return null
	}
}

async function autoLoadStreetMorphology(
	classifier: CreateRuntimePipelineOpts["classifier"]
): Promise<FSTMatcher | null> {
	const artifactPath =
		classifier && typeof classifier === "object" && "streetMorphologyPath" in classifier
			? (classifier as { streetMorphologyPath?: string }).streetMorphologyPath
			: undefined

	try {
		const loaded = await loadStreetMorphologyFST({
			...(artifactPath ? { artifactPath } : {}),
			onWarn: (message) => console.warn(`[mailwoman] ${message}`),
		})

		return loaded.matcher
	} catch (error) {
		console.warn(`[mailwoman] failed to load the street-morphology FST: ${(error as Error).message} — check off`)

		return null
	}
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
	let fstResolved = fstSource !== "auto"
	let morphologyResolved = streetMorphologySource !== "auto"

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

		if (!fstResolved) {
			fstResolved = true
			const matcher = await autoLoadWeightsFST(opts.classifier)

			if (matcher) {
				stages.fst = matcher
			}
		}

		if (!morphologyResolved) {
			morphologyResolved = true

			if (stages.fst) {
				const morph = await autoLoadStreetMorphology(opts.classifier)

				if (morph) {
					stages.streetMorphology = morph
				}
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
