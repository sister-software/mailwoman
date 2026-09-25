/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Defines `NeuralAddressClassifier`, which combines the tokenizer, the ONNX runner and the core decoder.
 */

import { conventionsForSystem, type SystemCode } from "@mailwoman/codex"
import type { ComponentTag } from "@mailwoman/codex/component"
import {
	buildAddressTree,
	decodeAsJSON,
	decodeAsTuples,
	decodeAsXML,
	type AddressTree,
	type DecoderToken,
	type SerializeJSONOpts,
	type SerializeTuplesOpts,
	type UnknownSpan,
} from "@mailwoman/core/decoder"
import { proposeSpans, type ProposedSpan, WORD_CONSISTENCY_SHIP_DEFAULT } from "@mailwoman/core/pipeline"
import type { PathBuilderLike } from "path-ts"

import { confidentLocaleCountry, LOCALE_COUNTRIES, resolveSystemVerdict } from "#address-system"
import { normalizeInputCase } from "#case-normalize"
import { encodeCharUnits } from "#char-encoder"
import type {
	NeuralAddressClassifierConfig,
	ParseOpts,
	ParseWithLogitsResult,
	SpanProposerConfig,
} from "#classifier/options"
import type { ScriptRoutedClassifier } from "#classifier/script-router"
import { buildFSTEmissionPriors } from "#fst-prior"
import { STAGE2_BIO_LABELS } from "#labels"
import type { InferFunction, InferCharsFunction } from "#ort-feeds"
import type { PlacetypeCensusLike } from "#placetype/census"
import { buildPlacetypePairPriors, type PlacetypePairProbeTrace } from "#placetype/pair-prior"
import { repairPostcodeLabels } from "#postcode/repair"
import { addEmissionMatrix, buildEmissionPriors } from "#query-shape-prior"
import { repairJPMunicipalityLabels, repairKRSubregionLabels } from "#register-boundary-repair"
import type { SemiCRFTransitions } from "#semi-markov-decode"
import { buildSoftFeatures, type SoftFeatureChannel, type SoftFeatures } from "#soft-features"
import { bridgePunctuationGaps } from "#span/bridge"
import { buildSpanProposalPriors } from "#span/proposal-prior"
import { buildCodexSpanLexicon } from "#span/proposer-lexicon"
import { buildStreetMorphologyEmissionPriors } from "#street-morphology-prior"
import type { MailwomanTokenizer, TokenizedPiece } from "#tokenizer"
import { TRACE_PRIOR_KINDS } from "#trace"
import type { NeuralParseTrace, TracePrior, TraceRepair, TraceRepairPass } from "#trace"
import { repairUnitLabels } from "#unit-repair"
import {
	argmaxWithConfidence,
	buildBIOEndMask,
	buildBIOStartMask,
	buildBIOTransitionMask,
	softmax,
	viterbi,
} from "#viterbi"
import { enforceWordConsistency } from "#word-consistency"

/**
 * Classifier configuration and parse option types.
 */
export type {
	NeuralAddressClassifierConfig,
	ParseOpts,
	ParseWithLogitsResult,
	SpanProposerConfig,
} from "#classifier/options"

/**
 * Script routing between weights families.
 */
export {
	type RoutableClassifier,
	carriesFamilySegment,
	routeFamilyForText,
	routeFamilyWithLeadingRun,
	routeFamilyWithPostcode,
	ScriptRoutedClassifier,
	scriptFamilyForText,
	type ScriptRoutedClassifierOpts,
} from "#classifier/script-router"

/**
 * The weights family registry.
 */
export {
	carriesFamilySegmentFor,
	FAMILIES,
	FAMILY_SCRIPTS,
	FAMILY_VOCABULARY_ARTIFACT,
	familyByID,
	FamilyEncoder,
	familyFallbackFor,
	familyForLocale,
	familyForScript,
	leadsWithFamilyScriptFor,
	RouteSource,
	type RoutingDecision,
	type WeightsFamily,
} from "#weights/families"

/**
 * The inference interface the classifier needs from a runner.
 *
 * Both the Node `ONNXRunner` and the browser `WebONNXRunner` satisfy it structurally.
 */
export interface NeuralRunner {
	infer: InferFunction
	/**
	 * Runs a character-input graph.
	 *
	 * A runner for a SentencePiece graph omits it.
	 * The classifier constructor rejects a runner without it when the config has a `charEncoder`.
	 */
	inferChars?: InferCharsFunction
}

/**
 * Builds the address tree and attaches the locale head's confident country when there is one.
 */
function treeWithLocaleCountry(
	text: string,
	tokens: DecoderToken[],
	calibrate: { calibrate: NonNullable<ParseOpts["calibrate"]> } | undefined,
	localeCountry: { country: string; confidence: number } | null
): AddressTree {
	return Object.assign(buildAddressTree(text, tokens, calibrate), localeCountry ? { localeCountry } : {})
}

/**
 * Parses address text into an `AddressTree` with a neural token classifier.
 *
 * `parse` returns the tree.
 * `parseJSON`, `parseTuples` and `parseXML` serialize it.
 */
export class NeuralAddressClassifier {
	private readonly labels: readonly string[]
	private readonly decodeMode: "viterbi" | "argmax"
	private readonly transitions: number[][]
	/**
	 * The default span proposer config, built on first use.
	 */
	#defaultProposerCfg: SpanProposerConfig | undefined
	private readonly startTransitions: number[]
	private readonly endTransitions: number[]
	private readonly cfg: NeuralAddressClassifierConfig

	/**
	 * The config this classifier was built from, exposed read-only for diagnostics.
	 */
	get config(): Readonly<NeuralAddressClassifierConfig> {
		return this.cfg
	}

	/**
	 * The encoder that feeds the graph.
	 *
	 * Input preparation depends on it.
	 * The character path keeps the postal mark 〒, and the SentencePiece path
	 * strips it (`NormalizeOpts.postalMark`).
	 */
	get encoder(): "sentencepiece" | "char" {
		return this.cfg.charEncoder ? "char" : "sentencepiece"
	}

	constructor(cfg: NeuralAddressClassifierConfig) {
		if (!cfg.tokenizer && !cfg.charEncoder) {
			throw new Error("NeuralAddressClassifier needs a tokenizer (SentencePiece graph) or a charEncoder (char graph)")
		}

		if (cfg.charEncoder && !cfg.runner.inferChars) {
			throw new Error("NeuralAddressClassifier: a charEncoder needs a runner with inferChars (a char_ids graph)")
		}

		this.cfg = cfg
		this.labels = cfg.labels ?? STAGE2_BIO_LABELS
		this.decodeMode = cfg.decode ?? "viterbi"
		const structural = buildBIOTransitionMask(this.labels)

		this.transitions = cfg.transitions ? addMatrices(structural, cfg.transitions) : structural
		this.startTransitions = cfg.startTransitions ?? buildBIOStartMask(this.labels)
		this.endTransitions = cfg.endTransitions ?? buildBIOEndMask(this.labels)
	}

	/**
	 * The semi-Markov segment-transition grammar from `semi-crf-transitions.json`.
	 *
	 * It is `undefined` when the bundle has no span grammar.
	 */
	get spanGrammar(): SemiCRFTransitions | undefined {
		return this.cfg.semiCRFGrammar
	}

	/**
	 * The path to the per-locale FST gazetteer (`fst-<locale>.bin`), or `undefined`
	 * when the weights package has none.
	 *
	 * The runtime pipeline loads it as the default `opts.fst`.
	 * Direct `parse` callers must pass an FST themselves.
	 */
	get fstPath(): PathBuilderLike | undefined {
		return this.cfg.fstPath
	}

	/**
	 * The path to the street-morphology FST (`fst-street-morphology.bin`), or `undefined`
	 * when the weights package and its base have none.
	 */
	get streetMorphologyPath(): string | undefined {
		return this.cfg.streetMorphologyPath
	}

	/**
	 * The loaded `model.onnx` path and the weights source that supplied it.
	 *
	 * It is `undefined` when the instance was constructed directly instead of through {@link loadFromWeights}.
	 */
	get resolvedWeights(): { modelPath: string; source: string } | undefined {
		return this.cfg.modelPath && this.cfg.weightsSource
			? { modelPath: this.cfg.modelPath, source: this.cfg.weightsSource }
			: undefined
	}

	/**
	 * Returns the default span proposer config, which uses the codex lexicon
	 * and the prior builder's default scales.
	 */
	private defaultProposer(): SpanProposerConfig {
		this.#defaultProposerCfg ??= { lexicon: buildCodexSpanLexicon() }

		return this.#defaultProposerCfg
	}

	/**
	 * Loads a classifier from a weights package through `#classifier/loader`.
	 *
	 * This method works only in Node. In a browser bundle the loader resolves to a module that throws, and browser
	 * callers use `loadNeuralClassifierFromURLs` instead. The `webpackIgnore` comment stops webpack's SSR bundle from
	 * following the Node import.
	 */
	static async loadFromWeights(
		...args: Parameters<typeof import("#classifier/loader").loadClassifierFromWeights>
	): Promise<NeuralAddressClassifier> {
		const { loadClassifierFromWeights } = await import(/* webpackIgnore: true */ "#classifier/loader")

		return loadClassifierFromWeights(...args)
	}

	/**
	 * Loads a {@link ScriptRoutedClassifier} whose primary classifier uses the caller's locale.
	 *
	 * Input written in another weights family's script runs on that family's classifier,
	 * which loads on first use.
	 * This method works only in Node.
	 */
	static async loadRoutedFromWeights(
		...args: Parameters<typeof import("#classifier/loader").loadScriptRoutedClassifier>
	): Promise<ScriptRoutedClassifier<NeuralAddressClassifier>> {
		const { loadScriptRoutedClassifier } = await import(/* webpackIgnore: true */ "#classifier/loader")

		return loadScriptRoutedClassifier(...args)
	}
	/**
	 * Parses text into an address tree.
	 */
	async parse(text: string, opts?: ParseOpts): Promise<AddressTree> {
		if (!text.length) return { raw: text, roots: [] }
		// All-caps ASCII input is title-cased because the model trained on mixed case.
		// The change preserves length, so offsets stay valid, and the tree values come out title-cased.
		const modelText = opts?.normalizeCase !== false ? normalizeInputCase(text) : text
		const { tokens, localeCountry } = await this.#decode(modelText, opts)

		return treeWithLocaleCountry(
			modelText,
			tokens,
			opts?.calibrate ? { calibrate: opts.calibrate } : undefined,
			localeCountry
		)
	}

	/**
	 * Parses text and also returns the per-piece logits and piece offsets.
	 *
	 * The tree comes from the same decode path and case normalization as `parse`, including repairs.
	 * The returned logits are the raw model output, before priors and repairs.
	 */
	async parseWithLogits(text: string, opts?: ParseOpts): Promise<ParseWithLogitsResult> {
		if (!text.length) {
			return { tree: { raw: text, roots: [] }, logits: [], pieces: [] }
		}

		const modelText = opts?.normalizeCase !== false ? normalizeInputCase(text) : text
		const { tokens, logits, pieces, localeCountry } = await this.#decode(modelText, opts)

		return {
			tree: treeWithLocaleCountry(
				modelText,
				tokens,
				opts?.calibrate ? { calibrate: opts.calibrate } : undefined,
				localeCountry
			),
			logits,
			pieces: pieces.map((p) => ({ start: p.start, end: p.end })),
		}
	}

	/**
	 * Parses text and returns the serializable decode trace instead of a tree.
	 *
	 * The trace uses the same decode path and case normalization as `parse`,
	 * so `buildAddressTree(trace.text, trace.tokens)` reproduces the tree from `parse`.
	 * The trace does not carry `opts.calibrate`, so a caller that needs calibrated
	 * confidences must pass the calibrator to the rebuild.
	 * See `#trace` for the schema.
	 */
	async traceParse(text: string, opts?: ParseOpts): Promise<NeuralParseTrace> {
		const labels = [...this.labels] as string[]

		if (!text.length) {
			// Empty input still reports the resolved conventions mode and a record for every prior kind.
			return {
				text,
				caseNormalized: false,
				pieces: [],
				logits: [],
				detectedSystem: null,
				systemSource: resolveSystemVerdict(
					opts?.addressSystemConventions ?? this.cfg.addressSystemConventions,
					undefined
				).systemSource,
				priors: TRACE_PRIOR_KINDS.map((kind) => ({ kind, applied: false })),
				emissions: [],
				labels,
				path: [],
				decode: this.decodeMode,
				repairs: [],
				tokens: [],
			}
		}

		const modelText = opts?.normalizeCase !== false ? normalizeInputCase(text) : text
		const { tokens, logits, pieces, trace } = await this.#decode(modelText, opts, true)

		if (!trace) throw new Error("traceParse: #decode returned no trace despite trace=true (invariant)")

		return {
			text: modelText,
			caseNormalized: modelText !== text,
			pieces: pieces.map((p) => ({ piece: p.piece, id: p.id, start: p.start, end: p.end })),
			...(trace.anchor ? { anchor: trace.anchor } : {}),
			...(trace.gazetteer ? { gazetteer: trace.gazetteer } : {}),
			...(trace.country ? { country: trace.country } : {}),
			logits,
			// The country order travels with the logits so consumers do not hardcode it.
			...(trace.localeLogits ? { localeLogits: trace.localeLogits, localeCountries: [...LOCALE_COUNTRIES] } : {}),
			...(trace.spanScores ? { spanScores: trace.spanScores } : {}),
			detectedSystem: trace.detectedSystem,
			systemSource: trace.systemSource,
			priors: trace.priors,
			emissions: trace.emissions,
			labels,
			path: trace.path,
			decode: this.decodeMode,
			repairs: trace.repairs,
			tokens: tokens.map((t) => ({ ...t })),
		}
	}

	/**
	 * Runs the shared decode path: encoding, soft features, inference, priors,
	 * Viterbi or argmax, and repairs.
	 *
	 * Every parse method calls this one function so that their decodes cannot diverge.
	 */
	// oxlint-disable-next-line complexity -- 104, and splitting it is what drifted last time
	async #decode(
		text: string,
		opts?: ParseOpts,
		trace = false
	): Promise<{
		tokens: DecoderToken[]
		logits: number[][]
		pieces: ReturnType<MailwomanTokenizer["encode"]>["pieces"]
		/**
		 * The locale head's confident country, or null.
		 */
		localeCountry: { country: string; confidence: number } | null
		/**
		 * The intermediates that `traceParse` needs, present only when `trace` is true.
		 */
		trace?: {
			anchor?: SoftFeatureChannel
			gazetteer?: SoftFeatureChannel
			country?: SoftFeatureChannel
			localeLogits?: number[]
			spanScores?: number[][][]
			detectedSystem: SystemCode | null
			systemSource: "off" | "auto" | "pinned"
			priors: TracePrior[]
			emissions: number[][]
			path: number[]
			repairs: TraceRepair[]
		}
	}> {
		const encoded = this.encode(text)
		// The pieces are truncated after inference to match the runner's sequence length.
		let pieces = encoded.pieces
		// Formatted input withholds the street-type and locality-surface channels
		// because they help fragments and hurt full addresses.
		// See `ParseOpts.inputMode`.
		const evidenceOn = (opts?.inputMode ?? "fragmented") === "fragmented"

		// The character path takes no soft-feature channels.
		const soft: SoftFeatures = encoded.charIDs
			? {}
			: buildSoftFeatures(text, pieces, {
					postcodeAnchorLookup: this.cfg.postcodeAnchorLookup,
					postcodeAnchorSpanMode: this.cfg.postcodeAnchorSpanMode,
					gazetteerLexicon: this.cfg.gazetteerLexicon,
					countryLexicon: this.cfg.countryLexicon,
					suppressGazetteerNearPostcode: this.cfg.suppressGazetteerNearPostcode,
					streetTypeLexicon: evidenceOn ? this.cfg.streetTypeLexicon : undefined,
					localitySurfaceLexicon: evidenceOn ? this.cfg.localitySurfaceLexicon : undefined,
				})

		const { logits, localeLogits, spanScores } = encoded.charIDs
			? await this.cfg.runner.inferChars!(encoded.charIDs, encoded.attentionMask!)
			: await this.cfg.runner.infer(
					encoded.ids,
					soft.anchor,
					soft.gazetteer,
					soft.country,
					soft.streetType || soft.localitySurface
						? { streetType: soft.streetType, localitySurface: soft.localitySurface }
						: undefined
				)

		this.assertEmissionWidth(logits)

		// Everything below requires one emission row per piece.
		// The runner truncates input to its fixed sequence length, so pieces past that
		// length are dropped here and never reach the model.
		if (pieces.length > logits.length) {
			pieces = pieces.slice(0, logits.length)
		}

		// These lists are null when not tracing, and every recording call below is guarded
		// so a plain parse allocates nothing for the trace.
		const tracePriors: TracePrior[] | null = trace ? [] : null
		const traceRepairs: TraceRepair[] | null = trace ? [] : null

		const recordRepair = (pass: TraceRepairPass, before: string[], after: string[]): void => {
			if (!traceRepairs) return

			if (before.length === after.length && before.every((label, i) => label === after[i])) return
			traceRepairs.push({ pass, before, after })
		}

		// Repair snapshots are per piece.
		// The span bridge merges tokens, so each piece takes the label of the token
		// that covers its start offset.
		const labelsPerPiece = (toks: readonly DecoderToken[]): string[] => {
			let t = 0

			return pieces.map((p) => {
				while (t + 1 < toks.length && toks[t + 1]!.start <= p.start) {
					t++
				}

				const tok = toks[t]

				return (tok && tok.start <= p.start && p.start < tok.end ? tok.label : "O") as string
			})
		}

		// A prior counts as applied only when at least one cell is nonzero.
		const matrixHasBias = (m: readonly (readonly number[])[]): boolean => m.some((row) => row.some((v) => v !== 0))

		// A null system applies no conventions.
		const conventionsOpt = opts?.addressSystemConventions ?? this.cfg.addressSystemConventions
		const { detectedSystem, systemSource } = resolveSystemVerdict(conventionsOpt, localeLogits)
		const conventions = conventionsForSystem(detectedSystem)

		const queryShapePrior = opts?.queryShape
			? buildEmissionPriors(opts.queryShape, pieces, this.labels, {
					biasScale: opts.queryShapeBiasScale ?? 1,
					inputText: text,
				})
			: undefined

		let emissions = queryShapePrior ? addEmissionMatrix(logits, queryShapePrior) : logits

		tracePriors?.push({ kind: "queryShape", applied: queryShapePrior !== undefined && matrixHasBias(queryShapePrior) })

		const fstPrior = opts?.fst
			? buildFSTEmissionPriors(opts.fst, pieces, this.labels, {
					biasScale: opts.fstBiasScale ?? 1,
					...(opts.fstImportanceLengthScaleMode
						? { importanceLengthScaleMode: opts.fstImportanceLengthScaleMode }
						: {}),
					// The street-context check reuses the street-morphology FST when one is loaded.
					...(opts.fstStreetMorphology && opts.fstStreetContextRequirement !== false
						? {
								streetContext: {
									fst: opts.fstStreetMorphology,
									...(opts.fstStreetContextPositiveScale !== undefined
										? { positiveScale: opts.fstStreetContextPositiveScale }
										: {}),
								},
							}
						: {}),
				})
			: undefined

		if (fstPrior) {
			emissions = addEmissionMatrix(emissions, fstPrior)
		}

		tracePriors?.push({ kind: "fst", applied: fstPrior !== undefined && matrixHasBias(fstPrior) })

		const morphologyPrior = opts?.fstStreetMorphology
			? buildStreetMorphologyEmissionPriors(
					opts.fstStreetMorphology,
					pieces,
					this.labels,
					opts.fstStreetMorphologyOpts ?? {}
				)
			: undefined

		if (morphologyPrior) {
			emissions = addEmissionMatrix(emissions, morphologyPrior)
		}

		tracePriors?.push({
			kind: "streetMorphology",
			applied: morphologyPrior !== undefined && matrixHasBias(morphologyPrior),
		})

		// The span proposer adds phrase priors.
		// It is on by default, and `spanProposer: false` in the config or the parse options turns it off.
		const configured = this.cfg.spanProposer === false ? undefined : (this.cfg.spanProposer ?? this.defaultProposer())
		const proposerCfg = (opts?.spanProposer ?? true) ? configured : undefined
		const spanProposals: ProposedSpan[] = proposerCfg ? proposeSpans(text, proposerCfg.lexicon) : []

		if (spanProposals.length) {
			emissions = addEmissionMatrix(emissions, buildSpanProposalPriors(spanProposals, pieces, this.labels, proposerCfg))
		}

		tracePriors?.push({ kind: "spanProposer", applied: spanProposals.length > 0 })

		// The placetype-pair prior is off unless the parse options or the config set it.
		// It runs before the conventions mask so the mask still removes any forbidden tag it favours.
		const placetypePairOpt = opts?.placetypePair ?? this.cfg.placetypePair
		// This record, allocated only when tracing, receives the probe path that fired.
		const pairProbeTrace: PlacetypePairProbeTrace | undefined = trace ? {} : undefined
		// The census is probed only when tracing.
		// Its observations go into the trace and never change a logit.
		const placetypeCensusOpt = opts?.placetypeCensus ?? this.cfg.placetypeCensus

		const censusForProbe: PlacetypeCensusLike | undefined = trace && placetypeCensusOpt ? placetypeCensusOpt : undefined

		const placetypePairResult = placetypePairOpt
			? buildPlacetypePairPriors(
					{
						...placetypePairOpt,
						inputText: text,
						probeTrace: pairProbeTrace ?? placetypePairOpt.probeTrace,
						...(censusForProbe ? { census: censusForProbe } : {}),
					},
					pieces,
					this.labels
				)
			: undefined

		const placetypePairPrior = placetypePairResult?.matrix

		if (placetypePairPrior) {
			emissions = addEmissionMatrix(emissions, placetypePairPrior)
		}

		// Transition adjustments are converted from label names to label indices.
		// Labels missing from the vocabulary are dropped, and an empty list stays `undefined`.
		const pairTransitionAdjustments = placetypePairResult?.transitionAdjustments.length
			? placetypePairResult.transitionAdjustments.flatMap((adj) => {
					const toLabel = this.labels.indexOf(adj.toLabel)

					return toLabel !== -1 ? [{ timestep: adj.pieceIndex, toLabel, bonus: adj.bonus }] : []
				})
			: undefined

		const placetypePairApplied = placetypePairPrior !== undefined && matrixHasBias(placetypePairPrior)

		tracePriors?.push({
			kind: "placetypePair",
			applied: placetypePairApplied,
			// The trace includes `probePath` only when the prior applied a bias.
			...(placetypePairApplied && pairProbeTrace?.firedPath ? { probePath: pairProbeTrace.firedPath } : {}),
		})

		// The census adds no bias, so `applied` is always false.
		// See `PlacetypeCensusHeader.delta`.
		// The observations appear only when a census is configured.
		tracePriors?.push({
			kind: "placetypeCensus",
			applied: false,
			...(pairProbeTrace?.censusProbedParents === undefined
				? {}
				: {
						census: pairProbeTrace.censusObservations ?? [],
						censusProbedParents: pairProbeTrace.censusProbedParents,
					}),
		})

		// Tags that the detected system forbids get an emission of -1e9, which acts as log 0.
		// The mask copies the matrix because `emissions` may alias `logits`,
		// and the token confidences below read unmasked logits.
		let conventionsMaskApplied = false

		if (conventions?.forbiddenTags?.length) {
			const forbidden = new Set<number>()

			for (const tag of conventions.forbiddenTags) {
				const b = this.labels.indexOf(`B-${tag}`)
				const i = this.labels.indexOf(`I-${tag}`)

				if (b !== -1) {
					forbidden.add(b)
				}

				if (i !== -1) {
					forbidden.add(i)
				}
			}

			if (forbidden.size) {
				conventionsMaskApplied = true
				emissions = emissions.map((row) => row.map((v, idx) => (forbidden.has(idx) ? -1e9 : v)))
			}
		}

		tracePriors?.push({ kind: "conventionsMask", applied: conventionsMaskApplied })

		let labelIndices =
			this.decodeMode === "viterbi"
				? viterbi({
						emissions,
						transitions: this.transitions,
						startTransitions: this.startTransitions,
						endTransitions: this.endTransitions,
						// The placetype-pair prior may add per-position transition bonuses.
						// Argmax decoding has no transitions, so it ignores them.
						...(pairTransitionAdjustments ? { transitionAdjustments: pairTransitionAdjustments } : {}),
					}).path
				: emissions.map((row) => argmaxWithConfidence(row).idx)

		// The trace records the decoder's path before the word-consistency repair changes it.
		const decodedPath = trace ? [...labelIndices] : null

		// The word-consistency repair gives all pieces of one whitespace-delimited word the
		// same tag, chosen by a confidence-weighted vote over the emissions.
		let healedConfidence: Map<number, number> | null = null

		// The default matches the shipped pipeline so a bare classifier decodes the same way production does.
		// The character path never runs the repair because unspaced text such as a
		// Japanese address would become one word.
		const wordConsistency = this.cfg.charEncoder
			? false
			: (opts?.enforceWordConsistency ?? this.cfg.enforceWordConsistency ?? WORD_CONSISTENCY_SHIP_DEFAULT)

		if (wordConsistency) {
			const beforeLabels = traceRepairs ? labelIndices.map((i) => (this.labels[i] ?? "O") as string) : []
			const wcOpts = typeof wordConsistency === "object" ? wordConsistency : undefined
			const wc = enforceWordConsistency(pieces, emissions, this.labels, labelIndices, wcOpts)
			labelIndices = wc.labelIndices
			healedConfidence = wc.healedConfidence

			if (traceRepairs) {
				recordRepair(
					"wordConsistency",
					beforeLabels,
					labelIndices.map((i) => (this.labels[i] ?? "O") as string)
				)
			}
		}

		let tokens: DecoderToken[] = pieces.map((p, i) => {
			const idx = labelIndices[i]!
			const probs = softmax(logits[i]!)

			return {
				piece: p.piece,
				start: p.start,
				end: p.end,
				label: (this.labels[idx] ?? "O") as DecoderToken["label"],
				// Repaired words take the vote's mean probability.
				// Other pieces keep their softmax probability.
				confidence: healedConfidence?.get(i) ?? probs[idx]!,
			}
		})

		// Postcode repair runs when requested or when the detected system defines a postcode pattern.
		// It extends a truncated postcode span, such as "4711" decoded from "47110".
		if (opts?.postcodeRepair || conventions?.postcodePattern) {
			const before = traceRepairs ? labelsPerPiece(tokens) : []
			tokens = repairPostcodeLabels(text, tokens).tokens

			if (traceRepairs) {
				recordRepair("postcodeRepair", before, labelsPerPiece(tokens))
			}
		}

		if (opts?.unitRepair) {
			const before = traceRepairs ? labelsPerPiece(tokens) : []
			tokens = repairUnitLabels(text, tokens).tokens

			if (traceRepairs) {
				recordRepair("unitRepair", before, labelsPerPiece(tokens))
			}
		}

		// On the character path, the register repairs extend an administrative span that the model closed early.
		// They match exact names from `JP_INNER_SHI_TOWNS` and `KR_SIGUNGU` in `@mailwoman/codex`.
		if (this.cfg.charEncoder) {
			for (const [pass, repair] of [
				["jpMunicipality", repairJPMunicipalityLabels],
				["krSubregion", repairKRSubregionLabels],
			] as const) {
				const before = traceRepairs ? labelsPerPiece(tokens) : []
				tokens = repair(text, tokens).tokens

				if (traceRepairs) {
					recordRepair(pass, before, labelsPerPiece(tokens))
				}
			}
		}

		// The opt-in punctuation bridge merges same-tag fragments split by punctuation, such as "P.O.
		// Box".
		// Annotation and quoted spans from the proposer block merges across their boundaries.
		if (opts?.bridgePunctuationGaps ?? this.cfg.bridgePunctuationGaps) {
			const blockedSpans = spanProposals.filter((p) => p.kind === "ANNOTATION_SPAN" || p.kind === "QUOTED_SPAN")
			const before = traceRepairs ? labelsPerPiece(tokens) : []
			tokens = bridgePunctuationGaps(text, tokens, blockedSpans.length ? { blockedSpans } : undefined)

			if (traceRepairs) {
				recordRepair("spanBridge", before, labelsPerPiece(tokens))
			}
		}

		return {
			tokens,
			logits,
			pieces,
			localeCountry: confidentLocaleCountry(localeLogits),
			...(trace
				? {
						trace: {
							...(soft.anchor ? { anchor: soft.anchor } : {}),
							...(soft.gazetteer ? { gazetteer: soft.gazetteer } : {}),
							...(soft.country ? { country: soft.country } : {}),
							...(localeLogits ? { localeLogits } : {}),
							...(spanScores ? { spanScores } : {}),
							detectedSystem,
							systemSource,
							priors: tracePriors!,
							emissions,
							path: decodedPath!,
							repairs: traceRepairs!,
						},
					}
				: {}),
		}
	}

	async parseJSON(text: string, opts?: ParseOpts): Promise<Partial<Record<ComponentTag, string>>>
	async parseJSON(
		text: string,
		opts: ParseOpts & SerializeJSONOpts
	): Promise<Partial<Record<ComponentTag, string>> & { unknown?: UnknownSpan[] }>
	async parseJSON(
		text: string,
		opts: ParseOpts & SerializeJSONOpts = {}
	): Promise<Partial<Record<ComponentTag, string>> & { unknown?: UnknownSpan[] }> {
		return decodeAsJSON(await this.parse(text, opts), opts)
	}

	async parseTuples(text: string, opts?: ParseOpts): Promise<Array<[ComponentTag, string]>>
	async parseTuples(
		text: string,
		opts: ParseOpts & SerializeTuplesOpts
	): Promise<Array<[ComponentTag | "unknown", string]>>
	async parseTuples(
		text: string,
		opts: ParseOpts & SerializeTuplesOpts = {}
	): Promise<Array<[ComponentTag | "unknown", string]>> {
		return decodeAsTuples(await this.parse(text, opts), opts)
	}

	async parseXML(text: string, opts?: ParseOpts & { xml?: Parameters<typeof decodeAsXML>[1] }): Promise<string> {
		return decodeAsXML(await this.parse(text, opts), opts?.xml)
	}

	/**
	 * Encodes text into the units the model reads.
	 *
	 * The SentencePiece path returns pieces with vocabulary ids.
	 * The character path returns one piece per code point with id 0, plus the
	 * `(S, W)` character ids that the graph reads.
	 */
	private encode(text: string): {
		pieces: TokenizedPiece[]
		ids: number[]
		charIDs?: number[][]
		attentionMask?: number[]
	} {
		if (this.cfg.charEncoder) {
			const encoding = encodeCharUnits(text, this.cfg.charEncoder.vocabulary, this.cfg.charEncoder.interface)

			return {
				pieces: encoding.units.map((unit) => ({ piece: unit.text, id: 0, start: unit.start, end: unit.end })),
				ids: [],
				charIDs: encoding.charIDs,
				attentionMask: encoding.attentionMask,
			}
		}

		return this.cfg.tokenizer!.encode(text)
	}

	/**
	 * Throws when the model emits more logits per token than there are labels.
	 *
	 * Without this check, Viterbi would index past the transition matrix and fail with an opaque error.
	 * A model with fewer logits than labels is allowed because each label set
	 * extends the previous stage's set as a prefix.
	 */
	private assertEmissionWidth(logits: readonly number[][]): void {
		if (!logits.length) return
		const width = logits[0]!.length

		if (width > this.labels.length) {
			throw new Error(
				`Label/emission mismatch: model emits ${width} logits per token but the classifier was ` +
					`configured with only ${this.labels.length} labels. Did you load a Stage 3 bundle without ` +
					`passing its model-card labels? See loadFromWeights / loadNeuralClassifierFromURLs.`
			)
		}
	}
}

/**
 * Adds two square matrices element by element.
 */
function addMatrices(a: number[][], b: number[][]): number[][] {
	const n = a.length
	const out: number[][] = []

	for (let i = 0; i < n; i++) {
		const row = new Array<number>(n)

		for (let j = 0; j < n; j++) {
			row[j] = a[i]![j]! + b[i]![j]!
		}

		out.push(row)
	}

	return out
}
