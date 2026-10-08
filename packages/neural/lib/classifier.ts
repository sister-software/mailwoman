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
import {
	DEFAULT_CASE_NORMALIZATION,
	proposeSpans,
	type ProposedSpan,
	WORD_CONSISTENCY_SHIP_DEFAULT,
	type WordConsistencySetting,
} from "@mailwoman/core/pipeline"
import { normalizeInputCase } from "@mailwoman/normalize/case"
import type { PathBuilderLike } from "path-ts"

import { confidentLocaleCountry, LOCALE_COUNTRIES, localeHintID, resolveSystemVerdict } from "#address-system"
import { encodeCharUnits } from "#char-encoder"
import type {
	AddressSystemConventions,
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
import type { NeuralParseTrace, TracePrior, TracePriorKind, TraceRepair, TraceRepairPass } from "#trace"
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

export type {
	AddressSystemConventions,
	NeuralAddressClassifierConfig,
	ParseOpts,
	ParseWithLogitsResult,
	PlacetypeCensusSelection,
	SpanProposerConfig,
	SpanProposerSelection,
} from "#classifier/options"

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
 * The inference interface the classifier needs from a runner, satisfied structurally
 * by both the Node `ONNXRunner` and the browser `WebONNXRunner`.
 */
export interface NeuralRunner {
	infer: InferFunction
	/**
	 * Runs a character-input graph, omitted by a SentencePiece runner and required
	 * by the constructor when the config has a `charEncoder`.
	 */
	inferChars?: InferCharsFunction
}

function treeWithLocaleCountry(
	text: string,
	tokens: DecoderToken[],
	calibrate: { calibrate: NonNullable<ParseOpts["calibrate"]> } | null,
	localeCountry: { country: string; confidence: number } | null
): AddressTree {
	return Object.assign(buildAddressTree(text, tokens, calibrate ?? undefined), localeCountry ? { localeCountry } : {})
}

/**
 * Parses address text into an `AddressTree` with a neural token classifier.
 *
 * `parseJSON`, `parseTuples` and `parseXML` serialize that tree.
 */
export class NeuralAddressClassifier {
	private readonly labels: readonly string[]
	private readonly decodeMode: "viterbi" | "argmax"
	private readonly transitions: number[][]

	#defaultProposerCfg: SpanProposerConfig | undefined
	private readonly startTransitions: number[]
	private readonly endTransitions: number[]
	private readonly cfg: NeuralAddressClassifierConfig

	get config(): Readonly<NeuralAddressClassifierConfig> {
		return this.cfg
	}

	/**
	 * The encoder that feeds the graph, where the character path keeps the postal mark 〒
	 * and the SentencePiece path strips it.
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
	 * The semi-Markov segment-transition grammar from `semi-crf-transitions.json`,
	 * `null` when the bundle has no span grammar.
	 */
	get spanGrammar(): SemiCRFTransitions | null {
		return this.cfg.semiCRFGrammar ?? null
	}

	/**
	 * The path to the per-locale FST gazetteer (`fst-<locale>.bin`) or `null` when the
	 * weights package has none, loaded by the runtime pipeline as the default `opts.fst`.
	 */
	get fstPath(): PathBuilderLike | null {
		return this.cfg.fstPath ?? null
	}

	/**
	 * The path to the street-morphology FST (`fst-street-morphology.bin`), or `null`
	 * when the weights package and its base have none.
	 */
	get streetMorphologyPath(): string | null {
		return this.cfg.streetMorphologyPath ?? null
	}

	/**
	 * The loaded `model.onnx` path and the weights source that supplied it, `null`
	 * when the instance was constructed directly instead of through {@link loadFromWeights}.
	 */
	get resolvedWeights(): { modelPath: string; source: string } | null {
		return this.cfg.modelPath && this.cfg.weightsSource
			? { modelPath: this.cfg.modelPath, source: this.cfg.weightsSource }
			: null
	}

	/**
	 * Returns the default span proposer config.
	 *
	 * It uses the codex lexicon and the prior builder's default scales.
	 */
	private defaultProposer(): SpanProposerConfig {
		this.#defaultProposerCfg ??= { lexicon: buildCodexSpanLexicon() }

		return this.#defaultProposerCfg
	}

	/**
	 * Resolves the span proposer for one parse, or `null` when it is disabled.
	 */
	private spanProposerFor(opts: ParseOpts | undefined): SpanProposerConfig | null {
		const selection = opts?.spanProposer ?? "inherit"
		const source = selection === "inherit" ? (this.cfg.spanProposer ?? "auto") : selection

		if (source === "none") return null

		return source === "auto" ? this.defaultProposer() : source
	}

	/**
	 * Resolves the address-system conventions for one parse.
	 */
	private conventionsFor(opts: ParseOpts | undefined): AddressSystemConventions {
		const selection = opts?.addressSystemConventions ?? "inherit"

		return selection === "inherit" ? (this.cfg.addressSystemConventions ?? "off") : selection
	}

	/**
	 * Loads a classifier from a weights package through `#classifier/loader`, Node-only
	 * because a browser bundle resolves the loader to a module that throws.
	 */
	static async loadFromWeights(
		...args: Parameters<typeof import("#classifier/loader").loadClassifierFromWeights>
	): Promise<NeuralAddressClassifier> {
		const { loadClassifierFromWeights } = await import(/* webpackIgnore: true */ "#classifier/loader")

		return loadClassifierFromWeights(...args)
	}

	/**
	 * Loads a {@link ScriptRoutedClassifier} whose primary classifier uses the caller's locale,
	 * routing another family's script to a lazily loaded classifier.
	 * This method works only in Node.
	 */
	static async loadRoutedFromWeights(
		...args: Parameters<typeof import("#classifier/loader").loadScriptRoutedClassifier>
	): Promise<ScriptRoutedClassifier<NeuralAddressClassifier>> {
		const { loadScriptRoutedClassifier } = await import(/* webpackIgnore: true */ "#classifier/loader")

		return loadScriptRoutedClassifier(...args)
	}

	async parse(text: string, opts?: ParseOpts): Promise<AddressTree> {
		if (!text) return { raw: text, roots: [] }

		// The model trained on mixed case, so this converts all-caps ASCII input to title case.
		// The conversion preserves length and keeps offsets valid.
		const modelText =
			(opts?.caseNormalization ?? DEFAULT_CASE_NORMALIZATION) === "title-case" ? normalizeInputCase(text) : text

		const { tokens, localeCountry } = await this.#decode(modelText, opts)

		return treeWithLocaleCountry(
			modelText,
			tokens,
			opts?.calibrate ? { calibrate: opts.calibrate } : null,
			localeCountry
		)
	}

	/**
	 * Parses text and also returns the per-piece logits and piece offsets, the tree from the
	 * same decode path as `parse` and the logits the raw model output before priors and repairs.
	 */
	async parseWithLogits(text: string, opts?: ParseOpts): Promise<ParseWithLogitsResult> {
		if (!text) {
			return { tree: { raw: text, roots: [] }, logits: [], pieces: [] }
		}

		const modelText =
			(opts?.caseNormalization ?? DEFAULT_CASE_NORMALIZATION) === "title-case" ? normalizeInputCase(text) : text

		const { tokens, logits, pieces, localeCountry } = await this.#decode(modelText, opts)

		return {
			tree: treeWithLocaleCountry(
				modelText,
				tokens,
				opts?.calibrate ? { calibrate: opts.calibrate } : null,
				localeCountry
			),
			logits,
			pieces: pieces.map((p) => ({ start: p.start, end: p.end })),
		}
	}

	/**
	 * Parses text and returns the serializable decode trace instead of a tree.
	 *
	 * `buildAddressTree(trace.text, trace.tokens)` reproduces the tree returned by `parse`.
	 * The trace omits `opts.calibrate`.
	 */
	async traceParse(text: string, opts?: ParseOpts): Promise<NeuralParseTrace> {
		const labels = [...this.labels] as string[]

		if (!text) {
			// Empty input still reports the resolved conventions mode and a record for every prior kind.
			return {
				text,
				caseNormalized: false,
				pieces: [],
				anchor: null,
				gazetteer: null,
				country: null,
				logits: [],
				localeLogits: null,
				spanScores: null,
				localeCountries: null,
				detectedSystem: null,
				systemSource: resolveSystemVerdict(this.conventionsFor(opts), null).systemSource,
				priors: TRACE_PRIOR_KINDS.map((kind) => untracedPrior(kind, false)),
				emissions: [],
				labels,
				path: [],
				decode: this.decodeMode,
				repairs: [],
				tokens: [],
			}
		}

		const modelText =
			(opts?.caseNormalization ?? DEFAULT_CASE_NORMALIZATION) === "title-case" ? normalizeInputCase(text) : text

		const { tokens, logits, pieces, trace } = await this.#decode(modelText, opts, true)

		if (!trace) throw new Error("traceParse: #decode returned no trace despite trace=true (invariant)")

		return {
			text: modelText,
			caseNormalized: modelText !== text,
			pieces: pieces.map((p) => ({ piece: p.piece, id: p.id, start: p.start, end: p.end })),
			anchor: trace.anchor,
			gazetteer: trace.gazetteer,
			country: trace.country,
			logits,
			localeLogits: trace.localeLogits,
			// The country order travels with the logits so consumers do not hardcode it.
			localeCountries: trace.localeLogits ? [...LOCALE_COUNTRIES] : null,
			spanScores: trace.spanScores,
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
	 * Runs the shared decode path used by every parse method.
	 *
	 * The path encodes input, computes soft features and inference, applies priors,
	 * runs Viterbi or argmax and applies repairs.
	 */
	// oxlint-disable-next-line complexity -- Complexity is 104. The previous split implementation drifted from this method.
	async #decode(
		text: string,
		opts?: ParseOpts,
		trace = false
	): Promise<{
		tokens: DecoderToken[]
		logits: number[][]
		pieces: ReturnType<MailwomanTokenizer["encode"]>["pieces"]

		localeCountry: { country: string; confidence: number } | null
		/**
		 * The intermediates that `traceParse` needs, present only when `trace` is true.
		 */
		trace?: {
			anchor: SoftFeatureChannel | null
			gazetteer: SoftFeatureChannel | null
			country: SoftFeatureChannel | null
			localeLogits: number[] | null
			spanScores: number[][][] | null
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
		const evidenceOn = (opts?.inputMode ?? "fragmented") === "fragmented"

		// The character path takes no soft-feature channels.
		const soft: SoftFeatures = encoded.charIDs
			? { anchor: null, gazetteer: null, country: null, streetType: null, localitySurface: null }
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
					soft.streetType || soft.localitySurface || this.cfg.addressSystems
						? {
								streetType: soft.streetType,
								localitySurface: soft.localitySurface,
								...(this.cfg.addressSystems
									? { localeHint: localeHintID(this.cfg.addressSystems, opts?.localeHint ?? null, text) }
									: {}),
							}
						: undefined
				)

		this.assertEmissionWidth(logits)

		// The runner truncates input to its fixed sequence length, so pieces past its
		// row count are dropped here and never reach the model.
		if (pieces.length > logits.length) {
			pieces = pieces.slice(0, logits.length)
		}

		// These lists are null when not tracing so a plain parse allocates no trace arrays.
		const tracePriors: TracePrior[] | null = trace ? [] : null
		const traceRepairs: TraceRepair[] | null = trace ? [] : null

		const recordRepair = (pass: TraceRepairPass, before: string[], after: string[]): void => {
			if (!traceRepairs) return

			if (before.length === after.length && before.every((label, i) => label === after[i])) return
			traceRepairs.push({ pass, before, after })
		}

		// Repair snapshots are per piece.
		// The span bridge merges tokens, so each piece takes the label of the token covering its start offset.
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

		const { detectedSystem, systemSource } = resolveSystemVerdict(this.conventionsFor(opts), localeLogits)
		const conventions = conventionsForSystem(detectedSystem)

		const queryShapePrior = opts?.queryShape
			? buildEmissionPriors(opts.queryShape, pieces, this.labels, {
					biasScale: opts.queryShapeBiasScale ?? 1,
					inputText: text,
				})
			: undefined

		let emissions = queryShapePrior ? addEmissionMatrix(logits, queryShapePrior) : logits

		tracePriors?.push(untracedPrior("queryShape", queryShapePrior !== undefined && matrixHasBias(queryShapePrior)))

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

		tracePriors?.push(untracedPrior("fst", fstPrior !== undefined && matrixHasBias(fstPrior)))

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

		tracePriors?.push(
			untracedPrior("streetMorphology", morphologyPrior !== undefined && matrixHasBias(morphologyPrior))
		)

		// The span proposer adds phrase priors and is on by default.
		const proposerCfg = this.spanProposerFor(opts)
		const spanProposals: ProposedSpan[] = proposerCfg ? proposeSpans(text, proposerCfg.lexicon) : []

		if (proposerCfg && spanProposals.length) {
			emissions = addEmissionMatrix(emissions, buildSpanProposalPriors(spanProposals, pieces, this.labels, proposerCfg))
		}

		tracePriors?.push(untracedPrior("spanProposer", spanProposals.length > 0))

		// The placetype-pair prior stays off unless options or config enable it.
		// It runs before the conventions mask, so the mask still removes any
		// forbidden tag that the prior favors.
		const placetypePairSelection = opts?.placetypePair ?? "inherit"

		const placetypePairOpt =
			placetypePairSelection === "inherit"
				? this.cfg.placetypePair
				: placetypePairSelection === "off"
					? undefined
					: placetypePairSelection

		// This record, allocated only when tracing, receives the probe path that fired.
		const pairProbeTrace: PlacetypePairProbeTrace | undefined = trace ? {} : undefined
		// The census is probed only when tracing.
		// Its observations enter the trace without changing a logit.
		const censusSelection = opts?.placetypeCensus ?? "inherit"

		const placetypeCensusOpt: PlacetypeCensusLike | undefined =
			censusSelection === "inherit" ? this.cfg.placetypeCensus : censusSelection === "off" ? undefined : censusSelection

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

		// Transition adjustments are converted from label names to label indices,
		// dropping labels missing from the vocabulary.
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
			probePath: (placetypePairApplied && pairProbeTrace?.firedPath) || null,
			census: null,
			censusProbedParents: null,
		})

		// The census adds no bias, so `applied` is always false and the observations
		// appear only when a census is configured.
		tracePriors?.push({
			kind: "placetypeCensus",
			applied: false,
			probePath: null,
			census: pairProbeTrace?.censusProbedParents === undefined ? null : (pairProbeTrace.censusObservations ?? []),
			censusProbedParents: pairProbeTrace?.censusProbedParents ?? null,
		})

		// Forbidden tags get an emission of -1e9 (log 0), and the mask copies the matrix
		// because `emissions` may alias `logits`.
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

		tracePriors?.push(untracedPrior("conventionsMask", conventionsMaskApplied))

		let labelIndices =
			this.decodeMode === "viterbi"
				? viterbi({
						emissions,
						transitions: this.transitions,
						startTransitions: this.startTransitions,
						endTransitions: this.endTransitions,
						// Argmax decoding has no transitions, so it ignores the placetype-pair
						// prior's per-position transition bonuses.
						...(pairTransitionAdjustments ? { transitionAdjustments: pairTransitionAdjustments } : {}),
					}).path
				: emissions.map((row) => argmaxWithConfidence(row).idx)

		// The trace records the decoder's path before the word-consistency repair changes it.
		const decodedPath = trace ? [...labelIndices] : null

		// The word-consistency repair gives all pieces of one whitespace-delimited word the
		// same tag, chosen by a confidence-weighted vote over the emissions.
		let healedConfidence: Map<number, number> | null = null

		// The default matches the shipped pipeline so a bare classifier decodes as
		// production does, but the character path never runs the repair because unspaced
		// text such as a Japanese address would become one word.
		const wordConsistency: WordConsistencySetting = this.cfg.charEncoder
			? "off"
			: (opts?.enforceWordConsistency ?? this.cfg.enforceWordConsistency ?? WORD_CONSISTENCY_SHIP_DEFAULT)

		if (wordConsistency !== "off") {
			const beforeLabels = traceRepairs ? labelIndices.map((i) => (this.labels[i] ?? "O") as string) : []
			const wc = enforceWordConsistency(pieces, emissions, this.labels, labelIndices, wordConsistency)
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
				// Repaired words take the vote's mean probability and other pieces keep their softmax probability.
				confidence: healedConfidence?.get(i) ?? probs[idx]!,
			}
		})

		// Postcode repair runs when requested or when the detected system defines a postcode
		// pattern, extending a truncated span such as "4711" decoded from "47110".
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

		// On the character path, the register repairs extend an administrative span the model
		// closed early, matching exact names from `JP_INNER_SHI_TOWNS` and `KR_SIGUNGU`.
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

		// The opt-in punctuation bridge merges same-tag fragments split by punctuation.
		// Annotation and quoted spans block merges across their boundaries.
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
							anchor: soft.anchor,
							gazetteer: soft.gazetteer,
							country: soft.country,
							localeLogits,
							spanScores,
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
	 * Encodes text into the units read by the model.
	 *
	 * The SentencePiece path returns pieces with vocabulary IDs.
	 * The character path returns one piece per code point plus the `(S, W)` character IDs read by the graph.
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
	 * Throws when the model emits more logits per token than there are labels,
	 * since Viterbi would otherwise index past the transition matrix.
	 *
	 * Fewer logits than labels is allowed because each label set extends the previous stage's set as a prefix.
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

/**
 * A trace record for a prior with no probe path or census observations.
 */
function untracedPrior(kind: TracePriorKind, applied: boolean): TracePrior {
	return { kind, applied, probePath: null, census: null, censusProbedParents: null }
}
