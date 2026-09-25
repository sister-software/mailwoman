/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { SystemCode } from "@mailwoman/codex"
import { readLocalBuffer, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import type { PathBuilderLike } from "path-ts"

import type { AnchorLookup } from "#anchor-inference"
import { parseCharVocabulary } from "#char-encoder"
import { NeuralAddressClassifier } from "#classifier/index"
import { ScriptRoutedClassifier } from "#classifier/script-router"
import { parseCountryLexicon } from "#country-inference"
import { parseGazetteerLexicon } from "#gazetteer-inference"
import type { GazetteerLexicon } from "#gazetteer-inference"
import { DEFAULT_INTRA_OP_THREADS, ONNXRunner } from "#onnx-runner"
import { peekPairIndexHeader, PairIndexResolver } from "#pair/index/resolver"
import type { PlacetypePairPriorOpts } from "#placetype/pair-prior"
import { parseSemiCRFTransitions, type SemiCRFTransitions } from "#semi-markov-decode"
import { MailwomanTokenizer } from "#tokenizer"
import type { ResolvedWeights, ResolveWeightsOpts } from "#weights"

/**
 * Loads the classifier for the caller's locale and routes inputs in another script,
 * such as CJK, to that weights family's classifier, loaded on first use.
 *
 * If that family's weights package is not installed, a warning is logged once
 * and those inputs stay on the primary classifier.
 */
export async function loadScriptRoutedClassifier(
	opts: Parameters<typeof loadClassifierFromWeights>[0] = {}
): Promise<ScriptRoutedClassifier<NeuralAddressClassifier>> {
	const primary = await loadClassifierFromWeights(opts)

	return new ScriptRoutedClassifier({
		primary,
		loadFamily: (family) =>
			loadClassifierFromWeights({ ...opts, locale: family, modelPath: undefined, tokenizerPath: undefined }),
		onFamilyUnavailable: (family, error) => {
			console.warn(
				`[neural] the ${family} weights family is not installed ` +
					// oxlint-disable-next-line mailwoman/prefer-spliterator -- An Error message rather than a data file.
					`(${error instanceof Error ? error.message.split("\n")[0] : String(error)}); ` +
					`inputs in that script run on the ${opts.locale ?? "en-US"} model. Install @mailwoman/neural-weights-${family}.`
			)
		},
	})
}

/**
 * Resolves a weights package and builds a {@link NeuralAddressClassifier} from its model,
 * tokenizer or character encoder, CRF transitions and optional channel artifacts.
 *
 * A channel artifact that is missing or fails to parse is warned about and skipped rather
 * than failing the load, and a pair index for another country than the locale's is ignored.
 */
export async function loadClassifierFromWeights(
	opts: ResolveWeightsOpts & {
		postcodeAnchorLookup?: AnchorLookup
		executionProviders?: string[]
		intraOpNumThreads?: number

		placetypeCensusPath?: PathBuilderLike

		suppressGazetteerNearPostcode?: boolean
	} = {}
): Promise<NeuralAddressClassifier> {
	/* oxlint-disable typescript/no-restricted-imports -- webpackIgnore keeps these out of the bundle */
	const [
		{ $public },
		{ resolveWeights, loadPlacetypeCensus },
		{
			readLabelsFromModelCard,
			readCRFTransitions,
			readRequiredChannels,
			loadAnchorLookup,
			unfedAnchorDetail,
			unfedChannelWarner,
		},
	] = await Promise.all([
		import(/* webpackIgnore: true */ "#env"),
		import(/* webpackIgnore: true */ "#weights"),
		import(/* webpackIgnore: true */ "#weights/channels"),
	])

	/* oxlint-enable typescript/no-restricted-imports */
	const resolved: ResolvedWeights = await resolveWeights(opts)

	const labels =
		(await readLabelsFromModelCard(resolved.modelCardPath)) ??
		(await readLabelsFromModelCard(resolved.baseModelCardPath))

	const crf = await readCRFTransitions(resolved.crfTransitionsPath)

	let semiCRFGrammar: SemiCRFTransitions | undefined

	if (resolved.semiCRFTransitionsPath) {
		try {
			semiCRFGrammar = parseSemiCRFTransitions(await readLocalJSONFile(resolved.semiCRFTransitionsPath))
		} catch (error) {
			console.error(
				`[mailwoman/neural] loadFromWeights: failed to parse ${resolved.semiCRFTransitionsPath} — ` +
					`the #727 phase-4c k-best rerank is unavailable (spanGrammar undefined): ${(error as Error).message}`
			)
		}
	}

	const charEncoder =
		resolved.encoder.kind === "char"
			? {
					vocabulary: parseCharVocabulary(await readLocalJSONFile(resolved.charVocabPath!), resolved.charVocabPath!),
					interface: {
						maxUnits: resolved.encoder.maxUnits,
						maxUnitWidth: resolved.encoder.maxUnitWidth,
						ctxChars: resolved.encoder.ctxChars,
					},
				}
			: undefined

	const [tokenizer, runner] = await Promise.all([
		charEncoder ? undefined : MailwomanTokenizer.loadFromFile(resolved.tokenizerPath),
		ONNXRunner.create(resolved.modelPath, {
			executionProviders: opts.executionProviders,

			intraOpNumThreads: opts.intraOpNumThreads ?? $public.MAILWOMAN_INTRA_OP_THREADS ?? DEFAULT_INTRA_OP_THREADS,
		}),
	])

	const declared = await readRequiredChannels(resolved.modelCardPath)

	let postcodeAnchorLookup = opts.postcodeAnchorLookup

	const warnUnfedChannel = unfedChannelWarner(`${opts.locale ?? "en-us"} (${resolved.packageDir ?? resolved.source})`)

	if (!postcodeAnchorLookup && resolved.anchorLookupPath) {
		try {
			postcodeAnchorLookup = await loadAnchorLookup(resolved.anchorLookupPath)
		} catch (error) {
			warnUnfedChannel("anchor", `failed to parse ${resolved.anchorLookupPath.path}: ${(error as Error).message}`)
		}
	}

	const anchorDetail =
		declared?.anchor?.required && !(postcodeAnchorLookup && postcodeAnchorLookup.size)
			? await unfedAnchorDetail(resolved.packageDir)
			: undefined

	if (anchorDetail) {
		warnUnfedChannel("anchor", anchorDetail)
	}

	const lexiconChannels: Array<{
		channel: "gazetteer" | "country" | "street_type" | "locality_surface"
		path: string | undefined
		parse: typeof parseGazetteerLexicon
		artifactName?: string
	}> = [
		{
			channel: "gazetteer",
			path: resolved.gazetteerLexiconPath,
			parse: parseGazetteerLexicon,
			artifactName: "anchor-lexicon-v1.json",
		},
		{
			channel: "country",
			path: resolved.countryLexiconPath,
			parse: parseCountryLexicon,
			artifactName: "country-surface-lexicon-v1.json",
		},
		{ channel: "street_type", path: resolved.streetTypeLexiconPath, parse: parseGazetteerLexicon },
		{ channel: "locality_surface", path: resolved.localitySurfaceLexiconPath, parse: parseGazetteerLexicon },
	]

	const lexicons: Partial<Record<(typeof lexiconChannels)[number]["channel"], GazetteerLexicon>> = {}

	for (const { channel, path, parse, artifactName } of lexiconChannels) {
		if (path) {
			try {
				lexicons[channel] = parse(await readLocalJSONFile(path))
			} catch (error) {
				warnUnfedChannel(channel, `failed to parse ${path}: ${(error as Error).message}`)
			}
		}

		if (artifactName && declared?.[channel]?.required && !lexicons[channel] && opts.tier !== "pocket") {
			warnUnfedChannel(
				channel,
				path ? `lexicon at ${path} could not be parsed` : `no ${artifactName} found in the weights package`
			)
		}
	}

	const gazetteerLexicon = lexicons.gazetteer
	const countryLexicon = lexicons.country
	const streetTypeLexicon = lexicons.street_type
	const localitySurfaceLexicon = lexicons.locality_surface

	let placetypePair: PlacetypePairPriorOpts | undefined

	if (resolved.pairIndexPath) {
		try {
			const pairIndexBytes = new Uint8Array(await readLocalBuffer(resolved.pairIndexPath))
			const peekedHeader = peekPairIndexHeader(pairIndexBytes)
			const localeCountry = (opts.locale ?? "en-us").toLowerCase().split("-")[1] ?? ""

			if (peekedHeader.country === localeCountry) {
				placetypePair = {
					index: new PairIndexResolver(pairIndexBytes),
					...($public.MAILWOMAN_PAIR_PARENT_DELTA === undefined
						? {}
						: { parentDelta: $public.MAILWOMAN_PAIR_PARENT_DELTA }),
				}
			} else {
				console.warn(
					`[mailwoman/neural] loadFromWeights: pair-index country "${peekedHeader.country}" ` +
						`(${resolved.pairIndexPath}) does not match the resolved locale's country "${localeCountry}" — ` +
						`skipping the placetype-pair prior default.`
				)
			}
		} catch (error) {
			console.error(
				`[mailwoman/neural] loadFromWeights: failed to parse ${resolved.pairIndexPath}: ${(error as Error).message}`
			)
		}
	}

	const placetypeCensus = await loadPlacetypeCensus(
		(opts.locale ?? "en-us").toLowerCase().split("-")[1] ?? "",
		opts.placetypeCensusPath
	)

	const suppressGazetteerNearPostcode =
		opts.suppressGazetteerNearPostcode ?? declared?.suppress_gazetteer_near_postcode ?? false

	const addressSystemConventions = declared?.conventions?.required ? (declared.conventions.mode ?? "auto") : undefined

	return new NeuralAddressClassifier({
		...(tokenizer ? { tokenizer } : {}),
		...(charEncoder ? { charEncoder } : {}),
		runner,
		labels,
		transitions: crf?.transitions,
		startTransitions: crf?.startTransitions,
		endTransitions: crf?.endTransitions,
		...(semiCRFGrammar ? { semiCRFGrammar } : {}),
		...(postcodeAnchorLookup ? { postcodeAnchorLookup, postcodeAnchorSpanMode: declared?.anchor?.span_mode } : {}),
		...(gazetteerLexicon ? { gazetteerLexicon } : {}),
		...(streetTypeLexicon ? { streetTypeLexicon } : {}),
		...(localitySurfaceLexicon ? { localitySurfaceLexicon } : {}),
		...(countryLexicon ? { countryLexicon } : {}),
		...(placetypePair ? { placetypePair } : {}),
		...(placetypeCensus ? { placetypeCensus } : {}),
		...(resolved.fstPath ? { fstPath: resolved.fstPath } : {}),
		...(resolved.streetMorphologyPath ? { streetMorphologyPath: resolved.streetMorphologyPath } : {}),
		modelPath: resolved.modelPath,
		weightsSource: resolved.source,
		...(suppressGazetteerNearPostcode ? { suppressGazetteerNearPostcode } : {}),

		...(addressSystemConventions ? { addressSystemConventions: addressSystemConventions as "auto" | SystemCode } : {}),
	})
}
