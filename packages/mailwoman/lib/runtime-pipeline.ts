/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import {
	runPipeline,
	type MachinePreferences,
	type PipelineOpts,
	type PipelineResult,
	type POIIntent,
	type POIIntentOutcome,
	type RuntimePipelineStages,
} from "@mailwoman/core/pipeline"
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
import { createPOIExecutor, type POIAncestryEntry } from "#poi/executor"
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
): (latitude: number, longitude: number) => ReadonlyArray<POIAncestryEntry> | undefined {
	return (latitude, longitude) => {
		try {
			const { hierarchy } = geocoder.reverseGeocodeSync(latitude, longitude)

			if (!hierarchy.length) return undefined

			return hierarchy.map((place) => ({ placetype: place.placetype, name: place.name, wofID: place.id }))
		} catch {
			return undefined
		}
	}
}

/**
 * Configures {@link createRuntimePipeline}'s stages and run defaults.
 *
 * For `placeCountry`, `streetEvidence`, `fst` and `streetMorphology`, leaving the option
 * undefined loads the bundled default on first parse and `false` disables the stage.
 */
export interface CreateRuntimePipelineOpts {
	/**
	 * The host locale preferences used only when neither the caller nor the input identifies a locale.
	 *
	 * `undefined` reads the current `Intl` defaults, `false` disables host inference,
	 * and `MW_LOCALE` overrides both.
	 */
	machinePreferences?: MachinePreferences | false

	/**
	 * The classification stage, typically a `NeuralAddressClassifier`.
	 */
	classifier?: RuntimePipelineStages["classifier"]

	/**
	 * The resolution stage, typically a `WOFResolver` from `@mailwoman/resolver-wof-sqlite`.
	 */
	resolver?: RuntimePipelineStages["resolver"]

	/**
	 * The FST gazetteer matcher that adds emission biases during classification.
	 *
	 * When omitted, the pipeline loads the classifier's `fstPath` sibling if it exists;
	 * `false` disables the matcher.
	 */
	fst?: RuntimePipelineStages["fst"] | false

	/**
	 * The street-morphology matcher behind the FST street-context check.
	 *
	 * When omitted and an FST matcher is active, the pipeline loads the sealed artifact
	 * or builds one from the bundled dictionaries; `false` disables it.
	 */
	streetMorphology?: RuntimePipelineStages["streetMorphology"] | false

	/**
	 * Replaces the default locale detector, which combines input structure,
	 * `MW_LOCALE` and the machine preferences.
	 */
	detectLocale?: RuntimePipelineStages["detectLocale"]

	/**
	 * Replaces the default kind classifier, including the POI-aware one that `poiQueryKind` would install.
	 */
	classifyKind?: RuntimePipelineStages["classifyKind"]

	/**
	 * Replaces the default rule-based phrase grouper.
	 */
	groupPhrases?: RuntimePipelineStages["groupPhrases"]

	/**
	 * The coarse country placer whose confident guess becomes a soft country prior for the resolver.
	 *
	 * When omitted, the bundled placer loads on the first call; `false` disables the prior.
	 */
	placeCountry?: RuntimePipelineStages["placeCountry"] | false

	/**
	 * The default for each call's `normalizeCase`, which title-cases all-caps input before the model.
	 *
	 * The classifier normalizes when this is unset, and a per-call value overrides it.
	 */
	normalizeCase?: boolean

	/**
	 * The default for each call's `hardPlaceCountry`, which promotes a confident
	 * placer guess from a soft prior to a hard country filter.
	 *
	 * It defaults to `true`, applies only to safelisted countries, and a per-call value overrides it.
	 */
	hardPlaceCountry?: boolean

	/**
	 * The default for each call's `hardCountrySafelist`; when unset, the resolver artifact's
	 * safelist applies, then the built-in `HARD_PLACE_COUNTRY_SAFELIST`.
	 */
	hardCountrySafelist?: ReadonlySet<string>

	/**
	 * The street-name evidence index for the classifier's k-best street rerank,
	 * which can add an index-confirmed street but never remove one.
	 *
	 * When omitted and the classifier has a span grammar, the bundled FR index loads
	 * on the first call; `false` disables the rerank.
	 */
	streetEvidence?: StreetLocalityEvidence | false

	/**
	 * Enables POI-query detection and intent extraction, defaulting to `true`,
	 * which extracts intents without executing them.
	 *
	 * `{ poiDatabasePath }` also executes intents against a lookup opened on the
	 * first call, and `false` removes the POI stage.
	 */
	poiQueryKind?: boolean | { poiDatabasePath?: PathBuilderLike }

	/**
	 * A last-resort phrase lookup consulted only after the category lexicon
	 * and the POI name lookup both miss, so it can never displace their hits.
	 *
	 * Its presence is the switch; if the pipeline ever builds one by default,
	 * this option must also accept `false`.
	 */
	poiSemanticLookup?: POIPhraseLookup
}

function wrapWithStreetEvidence(
	classifier: RuntimePipelineStages["classifier"],
	evidence: StreetLocalityEvidence | undefined
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

async function autoLoadWeightsFST(
	classifier: CreateRuntimePipelineOpts["classifier"]
): Promise<FSTMatcher | undefined> {
	const fstPath =
		classifier && typeof classifier === "object" && "fstPath" in classifier
			? (classifier as { fstPath?: PathBuilderLike }).fstPath
			: undefined

	if (!fstPath) return undefined

	try {
		return deserializeFST(await readLocalBuffer(fstPath))
	} catch (error) {
		console.warn(
			`[mailwoman] failed to load weights FST at ${fstPath}: ${(error as Error).message} — parsing without it`
		)

		return undefined
	}
}

async function autoLoadStreetMorphology(
	classifier: CreateRuntimePipelineOpts["classifier"]
): Promise<FSTMatcher | undefined> {
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

		return undefined
	}
}

/**
 * Read the JavaScript host's language and timezone as independent, diagnostic preference signals.
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
 * Creates the production parse function, which runs the full pipeline with the given stages
 * and fills omitted ones with bundled defaults.
 *
 * Default artifacts load lazily on the first call, and `hardPlaceCountry` is on
 * unless the options or the call turn it off.
 */
export function createRuntimePipeline(
	opts: CreateRuntimePipelineOpts = {}
): (raw: string, runOpts?: PipelineOpts) => Promise<PipelineResult> {
	const poiQueryKindEffective = opts.poiQueryKind ?? true

	const machinePreferences =
		opts.machinePreferences === false ? undefined : (opts.machinePreferences ?? getMachinePreferences())

	let poiNameLookup: POIPhraseLookup | undefined

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

		classifier: opts.streetEvidence ? wrapWithStreetEvidence(opts.classifier, opts.streetEvidence) : opts.classifier,

		fst: opts.fst === false ? undefined : opts.fst,
		streetMorphology: opts.streetMorphology === false ? undefined : opts.streetMorphology,
		resolver: opts.resolver,

		placeCountry: typeof opts.placeCountry === "function" ? opts.placeCountry : undefined,

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

	let poiExecute: ((intent: POIIntent) => POIIntentOutcome) | undefined = poiQueryKindEffective
		? createPOIExecutor({ lookup: undefined, requiresBuildLocal, resolveOvertureCategories })
		: undefined

	if (poiQueryKindEffective) {
		stages.poiIntent = createPOIIntentStage({
			lookup: poiSubjectLookup,

			parseAnchor: (text, runOpts) =>
				runPipeline(text, { ...stages, classifyKind: defaultClassifyKind, poiIntent: undefined }, runOpts),

			execute: (intent) => poiExecute!(intent),
		})
	}

	const autoPlaceCountry = opts.placeCountry === undefined
	let placeCountryResolved = !autoPlaceCountry

	let streetEvidenceResolved = opts.streetEvidence !== undefined

	const autoFST = opts.fst === undefined
	let fstResolved = !autoFST
	let morphologyResolved = opts.streetMorphology !== undefined

	const poiDatabasePath = typeof opts.poiQueryKind === "object" ? opts.poiQueryKind.poiDatabasePath : undefined
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
					reverseGeocode: reverseGeocoder ? buildSyncReverseGeocode(reverseGeocoder) : undefined,
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

		const factoryHardPlaceCountry = opts.hardPlaceCountry ?? true
		let effectiveRunOpts = runOpts

		if (opts.normalizeCase !== undefined && effectiveRunOpts?.normalizeCase === undefined) {
			effectiveRunOpts = { ...effectiveRunOpts, normalizeCase: opts.normalizeCase }
		}

		if (factoryHardPlaceCountry && effectiveRunOpts?.hardPlaceCountry === undefined) {
			effectiveRunOpts = { ...effectiveRunOpts, hardPlaceCountry: true }
		}

		if (opts.hardCountrySafelist && effectiveRunOpts?.hardCountrySafelist === undefined) {
			effectiveRunOpts = { ...effectiveRunOpts, hardCountrySafelist: opts.hardCountrySafelist }
		}

		const result = await runPipeline(raw, stages, effectiveRunOpts)

		stampSpanScripts(result.tree, result.normalized.normalized)

		return result
	}
}
