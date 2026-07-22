/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `NeuralAddressClassifier` ties together the tokenizer, the ONNX inference runner, and the
 *   `@mailwoman/core` decoder. Single user-facing entrypoint: `parse(text)` returns an
 *   `AddressTree` ready for projection into JSON / tuple / XML.
 *
 *   Convenience wrappers `parseJSON` / `parseTuples` / `parseXML` project the tree on the way out.
 */

import { conventionsForSystem, type SystemCode } from "@mailwoman/codex"
import {
	buildAddressTree,
	decodeAsJSON,
	decodeAsTuples,
	decodeAsXML,
	type AddressTree,
	type Calibrator,
	type ComponentTag,
	type DecoderToken,
	type SerializeJSONOpts,
	type SerializeTuplesOpts,
	type UnknownSpan,
} from "@mailwoman/core/decoder"
import { proposeSpans, type ProposedSpan, type SpanProposerLexicon } from "@mailwoman/core/pipeline"

import { detectAddressSystem, LOCALE_COUNTRIES } from "./address-system.ts"
import type { AnchorLookup } from "./anchor-inference.ts"
import { normalizeInputCase } from "./case-normalize.ts"
import type { CountryLexicon } from "./country-inference.ts"
import { buildFSTEmissionPriors, type FSTMatcherLike, type ImportanceLengthScaleMode } from "./fst-prior.ts"
import type { GazetteerLexicon } from "./gazetteer-inference.ts"
import { STAGE2_BIO_LABELS } from "./labels.ts"
import type { InferResult } from "./onnx-runner.ts"
import { buildPlacetypePairPriors, type PlacetypePairPriorOpts } from "./placetype-pair-prior.ts"
import { repairPostcodeLabels } from "./postcode-repair.ts"
import { addEmissionMatrix, buildEmissionPriors, type QueryShapeLike } from "./query-shape-prior.ts"
import { parseSemiCRFTransitions, type SemiCRFTransitions } from "./semi-markov-decode.ts"
import { buildSoftFeatures, type SoftFeatureChannel } from "./soft-features.ts"
import { bridgePunctuationGaps } from "./span-bridge.ts"
import { buildSpanProposalPriors, type SpanProposalPriorOpts } from "./span-proposal-prior.ts"
import { buildCodexSpanLexicon } from "./span-proposer-lexicon.ts"
import { buildStreetMorphologyEmissionPriors, type StreetMorphologyPriorOpts } from "./street-morphology-prior.ts"
import { MailwomanTokenizer } from "./tokenizer.ts"
import { TRACE_PRIOR_KINDS } from "./trace.ts"
import type { NeuralParseTrace, TracePrior, TraceRepair, TraceRepairPass } from "./trace.ts"
import { repairUnitLabels } from "./unit-repair.ts"
import { buildBIOEndMask, buildBIOStartMask, buildBIOTransitionMask, softmax, viterbi } from "./viterbi.ts"
import type { ResolveWeightsOpts, ResolvedWeights } from "./weights.ts"
import { enforceWordConsistency, type WordConsistencyOpts } from "./word-consistency.ts"

/**
 * Structural type the classifier needs from a runner. Lets callers swap the Node-side `ONNXRunner` for a browser-side
 * runner (e.g. `@mailwoman/neural-web`'s `WebONNXRunner`) without inheritance — the classifier only ever calls
 * `infer(ids)`.
 */
export interface NeuralRunner {
	infer(
		tokenIds: number[],
		anchor?: { features: ReadonlyArray<ReadonlyArray<number>>; confidence: ReadonlyArray<number> },
		gazetteer?: { features: ReadonlyArray<ReadonlyArray<number>>; confidence: ReadonlyArray<number> },
		country?: { features: ReadonlyArray<ReadonlyArray<number>>; confidence: ReadonlyArray<number> }
	): Promise<InferResult>
}

export interface NeuralAddressClassifierConfig {
	tokenizer: MailwomanTokenizer
	runner: NeuralRunner
	/**
	 * Label vocabulary in the order the model emits them. Defaults to Stage 2 (v0.3.0). Stage 2 strictly extends Stage 1
	 * at the same indices, so a v0.2.0 Stage 1 model loaded with this default still decodes correctly — its emissions
	 * only span the first 15 entries.
	 */
	labels?: readonly string[]
	/**
	 * Decoding strategy:
	 *
	 * - `"viterbi"` (default) — linear-chain CRF Viterbi with the BIO structural mask. Prevents orphan-`I-*` sequences. If
	 *   `transitions` is provided, uses learned scores on top.
	 * - `"argmax"` — per-token argmax. Faster but produces structurally invalid sequences. Use only for debugging /
	 *   comparison.
	 */
	decode?: "viterbi" | "argmax"
	/**
	 * Optional learned CRF transition scores. Square matrix of size `labels.length × labels.length`. Added on top of the
	 * structural BIO mask. Future weights releases ship this; today's v3.0.0 weights don't, so the structural mask alone
	 * is used.
	 */
	transitions?: number[][]
	/** Optional learned start-of-sequence transition scores per label. */
	startTransitions?: number[]
	/** Optional learned end-of-sequence transition scores per label. */
	endTransitions?: number[]
	/**
	 * #727 stage-2: the parsed semi-Markov segment-transition grammar (`semi-crf-transitions.json`), for the span head's
	 * k-best decode. `loadFromWeights` populates it when the bundle ships the sidecar; exposed via {@link spanGrammar} so
	 * the phase-4c name-evidence rerank can consume it without re-reading the file. Absent on a pre-v3 bundle.
	 */
	semiCrfGrammar?: SemiCRFTransitions
	/**
	 * Optional postcode-anchor lookup (#239/#240). When set, `parse` builds per-piece anchor features from the text +
	 * this lookup and feeds them to the runner — for models trained with the anchor channel (exported with the
	 * `anchor_features`/`anchor_confidence` ONNX inputs). Omit for plain models. Load via `loadAnchorLookup` from
	 * `./anchor-inference.js`.
	 */
	postcodeAnchorLookup?: AnchorLookup
	/**
	 * Optional gazetteer-anchor lexicon (#464, knowledge-ladder rung 3.2). When set, `parse` builds per-token
	 * candidate-tag-set clues (country/region/po_box/cedex/homograph) from the text + this lexicon and feeds them to the
	 * runner — for models trained with the gazetteer-anchor channel (exported with the
	 * `gazetteer_features`/`gazetteer_confidence` ONNX inputs). Omit for plain models. Load via `parseGazetteerLexicon`
	 * from `./gazetteer-inference.js`.
	 */
	gazetteerLexicon?: GazetteerLexicon
	/**
	 * Optional country-lexicon (#1104). When set, `parse` builds per-piece country-surface clues (`[country_surface,
	 * country_ambiguous]`) from the text + this lexicon and feeds them to the runner — for models trained with the
	 * country channel (exported with the `country_features`/`country_confidence` ONNX inputs). Omit for plain models.
	 * Load via `parseCountryLexicon` from `./country-inference.js`. Unlike the gazetteer country slot, this channel is
	 * NOT zeroed by `suppressGazetteerNearPostcode`.
	 */
	countryLexicon?: CountryLexicon
	/**
	 * Channel choreography (#464, v0.9.13 postcode fix): when true, zero the gazetteer clue on pieces adjacent to a
	 * postcode-anchor hit (needs both `gazetteerLexicon` and `postcodeAnchorLookup`). Targets the region-clue→postcode
	 * CRF interference (~3pp US postcode).
	 *
	 * PAIRING IS ESSENTIAL: set this IFF the model was TRAINED with the matching train-time choreography
	 * (`data.gazetteer_choreography`). The 2026-06-10 diagnostic showed the harm is WEIGHT-BAKED — applying this at
	 * inference on a model trained _without_ train-choreography does NOT recover postcode and adds train/inference skew.
	 * Only enable for a consolidation-era model trained with the train-time half.
	 */
	suppressGazetteerNearPostcode?: boolean
	/**
	 * Default address-system conventions mode for every parse (see `ParseOpts.addressSystemConventions` for semantics —
	 * `"auto"` reads the model's locale head; a `SystemCode` pins it). Per-parse opts override this. Omit for the
	 * byte-stable pre-#511 default (no detection, no mask).
	 */
	addressSystemConventions?: "auto" | SystemCode
	/**
	 * Punctuation-gap span bridging (the v4.4.0 corrective; see `span-bridge.ts`). The corpus label format cannot express
	 * punctuation inside a span, so dotted surfaces ("P.O. Box", "C.P.") decode as fragments. When true, adjacent
	 * same-tag spans separated only by short punctuation gaps are merged after decode. Per-parse opts override. Omit for
	 * the byte-stable pre-v4.4.0 behavior.
	 */
	bridgePunctuationGaps?: boolean
	/**
	 * Stage 2.7 span proposer (M2+M3 from the punctuation survey, #518). When set, every parse runs `proposeSpans`
	 * (`@mailwoman/core/pipeline`) over the raw text and consumes the typed proposals two ways: (a) as additive emission
	 * priors — the phrase-prior path; the classifier conditions on the boundary hypotheses and can still disagree — and
	 * (b) ANNOTATION/QUOTED span boundaries feed the span bridge as merge-crossing constraints (no same-tag merge may
	 * straddle a structural delimiter). Build the lexicon with `buildCodexSpanLexicon` (`./span-proposer-lexicon.js`).
	 * Per-parse opts override.
	 *
	 * DEFAULT ON (operator ruling 2026-06-12, after the #518 measurement closed both v0-win quadrants with no class
	 * down): omitting this builds the codex lexicon lazily with the frozen measured scales (biasScale 5.0 /
	 * annotationBiasScale 12.0). Pass `false` for the proposer-free baseline (the pre-2026-06-12 byte-stable default).
	 */
	spanProposer?: SpanProposerConfig | false

	/**
	 * Default placetype-pair index (placetype-pair-prior arc, Task 5 — see `ParseOpts.placetypePair` for the full
	 * matching contract). Set by `loadFromWeights` when the resolved weights package ships a country-matching
	 * `pair-index-<cc>.bin` (the hard country gate — see that method). Per-parse `opts.placetypePair` overrides this
	 * default; omitting both is the byte-stable no-prior default (undefined → zero matrix).
	 */
	placetypePair?: PlacetypePairPriorOpts

	/**
	 * Per-word BIO consistency repair (#727 + the admin-token fragmentation class). Default off → byte-identical. When
	 * enabled, every `▁`-delimited word's pieces are forced to ONE tag by a confidence-weighted vote over the post-prior
	 * emissions (see word-consistency.ts). Pass a `WordConsistencyOpts` object to enable WITH the #727 confidence gates
	 * (floor / byte-fallback skip / slash grouping); `true` = the original ungated vote. Per-parse
	 * `ParseOptions.enforceWordConsistency` overrides this default.
	 */
	enforceWordConsistency?: boolean | WordConsistencyOpts
}

/**
 * Config for the Stage 2.7 span-proposer integration (see `NeuralAddressClassifierConfig.spanProposer`).
 */
export interface SpanProposerConfig extends SpanProposalPriorOpts {
	/** Codex-backed designator vocabulary (`buildCodexSpanLexicon`). */
	lexicon: SpanProposerLexicon
}

export class NeuralAddressClassifier {
	private readonly labels: readonly string[]
	private readonly decodeMode: "viterbi" | "argmax"
	private readonly transitions: number[][]
	/** Lazily-built default Stage 2.7 config (codex lexicon, frozen scales) — see `cfg.spanProposer`. */
	#defaultProposerCfg: SpanProposerConfig | undefined
	private readonly startTransitions: number[]
	private readonly endTransitions: number[]
	private readonly cfg: NeuralAddressClassifierConfig

	constructor(cfg: NeuralAddressClassifierConfig) {
		this.cfg = cfg
		this.labels = cfg.labels ?? STAGE2_BIO_LABELS
		this.decodeMode = cfg.decode ?? "viterbi"
		const structural = buildBIOTransitionMask(this.labels)

		if (cfg.transitions) {
			this.transitions = addMatrices(structural, cfg.transitions)
		} else {
			this.transitions = structural
		}
		this.startTransitions = cfg.startTransitions ?? buildBIOStartMask(this.labels)
		this.endTransitions = cfg.endTransitions ?? buildBIOEndMask(this.labels)
	}

	/**
	 * The parsed semi-Markov segment-transition grammar (`semi-crf-transitions.json`), when the loaded bundle shipped it.
	 * Consumed by the #727 phase-4c k-best name-evidence rerank; `undefined` on a pre-v3 (span-less) bundle.
	 */
	get spanGrammar(): SemiCRFTransitions | undefined {
		return this.cfg.semiCrfGrammar
	}

	/**
	 * The default-ON Stage 2.7 config: codex lexicon (us/au/nz), frozen measured scales (the prior builder's own
	 * defaults). Built once per instance, only when a parse actually needs it.
	 */
	private defaultProposer(): SpanProposerConfig {
		this.#defaultProposerCfg ??= { lexicon: buildCodexSpanLexicon() }

		return this.#defaultProposerCfg
	}

	/**
	 * One-call factory that resolves the weights package (or explicit paths), loads the tokenizer and ONNX runner, and
	 * returns a ready-to-use classifier.
	 *
	 * Resolution order: explicit paths in `opts` → `@mailwoman/neural-weights-<locale>` package → throws a single
	 * actionable error.
	 *
	 * **Node-only.** The dynamic imports keep `ONNXRunner` (onnxruntime-node) + `resolveWeights` (uses Node fs) out of
	 * the static dependency graph, so this file can be bundled for the browser by `@mailwoman/neural-web`. Calling this
	 * method in a browser will throw at runtime — use `loadNeuralClassifierFromURLs` from `@mailwoman/neural-web`
	 * instead.
	 */
	static async loadFromWeights(
		opts: ResolveWeightsOpts & { postcodeAnchorLookup?: AnchorLookup; executionProviders?: string[] } = {}
	): Promise<NeuralAddressClassifier> {
		// /* webpackIgnore: true */ tells webpack to leave the dynamic import statement intact —
		// it becomes a runtime native ESM import that resolves in Node (which has onnxruntime-node
		// + node:fs) and throws cleanly in a browser if called. Without the directive, webpack
		// pulls onnx-runner / weights into the browser chunk graph + then chokes on the Node-only
		// builtins they reference.
		const [
			{ ONNXRunner },
			{ resolveWeights, readLabelsFromModelCard, readCrfTransitions, readRequiredChannels },
			{ parseAnchorLookup },
			{ parseGazetteerLexicon },
			{ parseCountryLexicon },
			{ PostcodeBinaryResolver },
			{ PairIndexResolver, peekPairIndexHeader },
			fs,
		] = await Promise.all([
			import(/* webpackIgnore: true */ "./onnx-runner.ts"),
			import(/* webpackIgnore: true */ "./weights.ts"),
			import(/* webpackIgnore: true */ "./anchor-inference.ts"),
			import(/* webpackIgnore: true */ "./gazetteer-inference.ts"),
			import(/* webpackIgnore: true */ "./country-inference.ts"),
			import(/* webpackIgnore: true */ "./postcode-binary-resolver.ts"),
			import(/* webpackIgnore: true */ "./pair-index-resolver.ts"),
			import(/* webpackIgnore: true */ "node:fs"),
		])
		const resolved: ResolvedWeights = resolveWeights(opts)
		const labels = readLabelsFromModelCard(resolved.modelCardPath)
		const crf = readCrfTransitions(resolved.crfTransitionsPath)
		// #727 stage-2: parse the span head's segment-transition grammar when the bundle ships it (v3+). Failure to parse
		// is non-fatal — the model still classifies; only the phase-4c k-best rerank goes unavailable (spanGrammar stays
		// undefined).
		let semiCrfGrammar: SemiCRFTransitions | undefined

		if (resolved.semiCrfTransitionsPath) {
			try {
				semiCrfGrammar = parseSemiCRFTransitions(JSON.parse(fs.readFileSync(resolved.semiCrfTransitionsPath, "utf8")))
			} catch (err) {
				console.error(
					`[mailwoman/neural] loadFromWeights: failed to parse ${resolved.semiCrfTransitionsPath} — ` +
						`the #727 phase-4c k-best rerank is unavailable (spanGrammar undefined): ${(err as Error).message}`
				)
			}
		}
		const [tokenizer, runner] = await Promise.all([
			MailwomanTokenizer.loadFromFile(resolved.tokenizerPath),
			ONNXRunner.create(resolved.modelPath, { executionProviders: opts.executionProviders }),
		])

		// --- Soft-feed (#718 D1): feed the channels the SHIPPED model was trained against ----------
		// The anchor-trained en-us model goes OOD when scored anchor-OFF (the #566/#685 crater: country
		// ~0, region 71, locality 57 vs the server-tier 68/90/77). The browser loader already feeds the
		// channels from URLs; this is the Node-side mirror so EVERY consumer (ResolveRouter,
		// GeocodeRouter, geocode.tsx, the CLI) transparently gains them with no callsite change.
		//
		// SOFT: each channel is best-effort. A caller-passed `postcodeAnchorLookup` always wins. When
		// the model-card declares a channel REQUIRED but the package didn't ship its data, we warn ONCE
		// (mirroring neural-web's `warnOnUnfedTrainedChannels`) and run that channel OFF — never crash.
		const declared = readRequiredChannels(resolved.modelCardPath)

		let postcodeAnchorLookup = opts.postcodeAnchorLookup

		if (!postcodeAnchorLookup && resolved.anchorLookupPath) {
			try {
				postcodeAnchorLookup = resolved.anchorLookupPath.binary
					? new PostcodeBinaryResolver(new Uint8Array(fs.readFileSync(resolved.anchorLookupPath.path))).toAnchorLookup()
					: parseAnchorLookup(JSON.parse(fs.readFileSync(resolved.anchorLookupPath.path, "utf8")))
			} catch (err) {
				warnUnfedChannel("anchor", `failed to parse ${resolved.anchorLookupPath.path}: ${(err as Error).message}`)
			}
		}

		if (declared?.anchor?.required && !(postcodeAnchorLookup && postcodeAnchorLookup.size > 0)) {
			warnUnfedChannel(
				"anchor",
				resolved.anchorLookupPath
					? `parsed lookup at ${resolved.anchorLookupPath.path} is empty`
					: `no postcode-<cc>.bin / anchor-lookup.json found in the weights package`
			)
		}

		let gazetteerLexicon: GazetteerLexicon | undefined

		if (resolved.gazetteerLexiconPath) {
			try {
				gazetteerLexicon = parseGazetteerLexicon(JSON.parse(fs.readFileSync(resolved.gazetteerLexiconPath, "utf8")))
			} catch (err) {
				warnUnfedChannel("gazetteer", `failed to parse ${resolved.gazetteerLexiconPath}: ${(err as Error).message}`)
			}
		}

		// Pocket tier is anchor-only: `resolveWeights` already withholds the gazetteer path, so a
		// declared-required gazetteer is EXPECTED to be unfed there — don't warn. Otherwise warn.
		if (declared?.gazetteer?.required && !gazetteerLexicon && opts.tier !== "pocket") {
			warnUnfedChannel(
				"gazetteer",
				resolved.gazetteerLexiconPath
					? `lexicon at ${resolved.gazetteerLexiconPath} could not be parsed`
					: `no anchor-lexicon-v1.json found in the weights package`
			)
		}

		// Country-lexicon channel (#1104): same soft-feed pattern. Ships with the server tier; pocket is anchor-only.
		let countryLexicon: CountryLexicon | undefined

		if (resolved.countryLexiconPath) {
			try {
				countryLexicon = parseCountryLexicon(JSON.parse(fs.readFileSync(resolved.countryLexiconPath, "utf8")))
			} catch (err) {
				warnUnfedChannel("country", `failed to parse ${resolved.countryLexiconPath}: ${(err as Error).message}`)
			}
		}

		if (declared?.country?.required && !countryLexicon && opts.tier !== "pocket") {
			warnUnfedChannel(
				"country",
				resolved.countryLexiconPath
					? `lexicon at ${resolved.countryLexiconPath} could not be parsed`
					: `no country-surface-lexicon-v1.json found in the weights package`
			)
		}

		// Placetype-pair index sibling (placetype-pair-prior arc, Task 5): construct a PairIndexResolver
		// when the package shipped one for this country. HARD COUNTRY GATE — an index built for one
		// country must never bias a parse resolved for a different locale (a mismatch is a packaging bug,
		// not something to apply anyway): the index header's `country` must equal the resolved locale's
		// country subtag, or the default is skipped with a single warning naming both. Unlike the
		// anchor/gazetteer/country soft-feed channels above, there is no "declared required" fail-closed
		// case here — the prior is opt-in plumbing (Task 7 owns the ship decision), so a missing/mismatched
		// index degrades silently to the pre-Task-5 byte-stable default, loud only via the gate warning.
		//
		// Review follow-up (header peek before construction): the country check reads ONLY the magic +
		// header block via `peekPairIndexHeader` — no entry parsing, no Map build — so a mismatched index
		// never pays the full-parse cost just to be discarded. The `PairIndexResolver` constructor (which
		// DOES walk every entry) only runs once the gate has already confirmed the country match.
		let placetypePair: PlacetypePairPriorOpts | undefined

		if (resolved.pairIndexPath) {
			try {
				const pairIndexBytes = new Uint8Array(fs.readFileSync(resolved.pairIndexPath))
				const peekedHeader = peekPairIndexHeader(pairIndexBytes)
				const localeCountry = (opts.locale ?? "en-us").toLowerCase().split("-")[1] ?? ""

				if (peekedHeader.country === localeCountry) {
					placetypePair = { index: new PairIndexResolver(pairIndexBytes) }
				} else {
					console.warn(
						`[mailwoman/neural] loadFromWeights: pair-index country "${peekedHeader.country}" ` +
							`(${resolved.pairIndexPath}) does not match the resolved locale's country "${localeCountry}" — ` +
							`skipping the placetype-pair prior default.`
					)
				}
			} catch (err) {
				console.error(
					`[mailwoman/neural] loadFromWeights: failed to parse ${resolved.pairIndexPath}: ${(err as Error).message}`
				)
			}
		}

		// Near-postcode gazetteer choreography + conventions mode: drive them off the card's declared
		// SHIP-CONFIG (mirrors createScorer / the browser loader defaults), inert when the source
		// channel is absent. Byte-stable for a non-anchor card (no `requires` → all undefined/false).
		const suppressGazetteerNearPostcode = declared?.suppress_gazetteer_near_postcode ?? false
		const addressSystemConventions = declared?.conventions?.required ? (declared.conventions.mode ?? "auto") : undefined

		return new NeuralAddressClassifier({
			tokenizer,
			runner,
			labels,
			transitions: crf?.transitions,
			startTransitions: crf?.startTransitions,
			endTransitions: crf?.endTransitions,
			...(semiCrfGrammar ? { semiCrfGrammar } : {}),
			...(postcodeAnchorLookup ? { postcodeAnchorLookup } : {}),
			...(gazetteerLexicon ? { gazetteerLexicon } : {}),
			...(countryLexicon ? { countryLexicon } : {}),
			...(placetypePair ? { placetypePair } : {}),
			...(suppressGazetteerNearPostcode ? { suppressGazetteerNearPostcode } : {}),
			...(addressSystemConventions ? { addressSystemConventions: addressSystemConventions as "auto" } : {}),
		})
	}

	/** Tokenize → infer → Viterbi (or argmax) → decoder tree. */
	async parse(text: string, opts?: ParseOpts): Promise<AddressTree> {
		if (text.length === 0) return { raw: text, roots: [] }
		// #690: title-case all-caps ASCII input so the mixed-case-trained model doesn't go OOD.
		// Detection-gated (mixed-case + non-ASCII untouched). Default-ON (#895 settled drift D2 — the geocode
		// path had run it since #713 while the pipeline factory + raw classifier defaulted off); `false`
		// restores the raw-case parse. ASCII title-case is char-for-char length-preserving, so token offsets
		// are unaffected; the tree is built from the normalized text (values come out title-cased — the
		// SHOUTING is gone, the resolver name-matches case-insensitively).
		const modelText = opts?.normalizeCase !== false ? normalizeInputCase(text) : text
		const { tokens } = await this.#decode(modelText, opts)

		return buildAddressTree(modelText, tokens, opts?.calibrate ? { calibrate: opts.calibrate } : undefined)
	}

	/**
	 * Like `parse`, but also returns the raw per-token logits and piece offsets needed for per-span logit aggregation
	 * (Option C joint-reconcile integration). Shares the ENTIRE decode path with `parse` (one `#decode`, #481) —
	 * including the repair passes, which previously ran only in `parse`: reconcile must consume the same tokens the
	 * argmax path serves users, and the repair opts were silently ignored here before. `logits` stay RAW (pre-prior,
	 * pre-repair) — they are the model's emissions, not the decode's opinions.
	 */
	async parseWithLogits(text: string, opts?: ParseOpts): Promise<ParseWithLogitsResult> {
		if (text.length === 0) {
			return { tree: { raw: text, roots: [] }, logits: [], pieces: [] }
		}
		const { tokens, logits, pieces } = await this.#decode(text, opts)

		return {
			tree: buildAddressTree(text, tokens, opts?.calibrate ? { calibrate: opts.calibrate } : undefined),
			logits,
			pieces: pieces.map((p) => ({ start: p.start, end: p.end })),
		}
	}

	/**
	 * Like `parse`, but returns the full decode-path trace instead of a tree: pieces, soft-feature channels as fed, raw
	 * logits, locale head, prior participation, post-prior emissions, viterbi path, repair diffs, and the final tokens.
	 * Shares the ENTIRE decode path with `parse` (one `#decode`, #481) and mirrors `parse`'s case normalization, so
	 * `buildAddressTree(trace.text, trace.tokens)` reproduces `parse(text)`'s tree exactly — modulo `opts.calibrate`,
	 * which `parse` forwards into the tree build to recalibrate node confidences and which the trace does not carry
	 * (tokens/labels/spans still match; re-pass the calibrator to the rebuild if calibrated confidences matter).
	 * Serializable by construction — see `./trace.js` for the schema and the spec reference.
	 */
	async traceParse(text: string, opts?: ParseOpts): Promise<NeuralParseTrace> {
		const labels = [...this.labels] as string[]

		if (text.length === 0) {
			// Mirror #decode's contract on the degenerate input: systemSource still reflects the
			// RESOLVED conventions mode (opts over config), and every prior kind gets its
			// participation record (applied: false — nothing can fire on zero pieces).
			const conventionsOpt = opts?.addressSystemConventions ?? this.cfg.addressSystemConventions

			return {
				text,
				caseNormalized: false,
				pieces: [],
				logits: [],
				detectedSystem: null,
				systemSource: conventionsOpt === undefined ? "off" : conventionsOpt === "auto" ? "auto" : "pinned",
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
			// The axis rides with the values (self-describing — consumers must not hardcode the order).
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
	 * THE decode path (#481): tokenize → anchor/gazetteer features → infer → priors → CRF/argmax → tokens → repairs. Both
	 * `parse` and `parseWithLogits` consume this — never fork it; the 2026-06 audit found three drift surfaces in the
	 * previous duplicated copies.
	 */
	async #decode(
		text: string,
		opts?: ParseOpts,
		trace = false
	): Promise<{
		tokens: DecoderToken[]
		logits: number[][]
		pieces: ReturnType<MailwomanTokenizer["encode"]>["pieces"]
		/** Present iff `trace` — the retained intermediates `traceParse` assembles. */
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
		const { pieces, ids } = this.cfg.tokenizer.encode(text)
		// Soft-feature channels (#718): the postcode-anchor (#239/#240) + gazetteer-anchor (#464) clues
		// the model conditions on alongside the ids, plus the near-postcode gazetteer choreography. The
		// build + choreography is the single PURE `buildSoftFeatures` (soft-features.ts) — both this
		// decode path and the ProductionScorer feed channels identically, so there is exactly one
		// choreography. Each channel is undefined when its source is unconfigured (no-op).
		const soft = buildSoftFeatures(text, pieces, {
			postcodeAnchorLookup: this.cfg.postcodeAnchorLookup,
			gazetteerLexicon: this.cfg.gazetteerLexicon,
			countryLexicon: this.cfg.countryLexicon,
			suppressGazetteerNearPostcode: this.cfg.suppressGazetteerNearPostcode,
		})
		const { logits, localeLogits, spanScores } = await this.cfg.runner.infer(
			ids,
			soft.anchor,
			soft.gazetteer,
			soft.country
		)

		this.assertEmissionWidth(logits)

		// Trace retention (spec 2026-07-03): capture-by-reference of arrays this method already
		// builds. Null when not tracing — the non-trace path allocates nothing new (every recording
		// call below sits behind a `tracePriors?` / `if (traceRepairs)` guard, so even snapshot
		// arguments are never built for a plain parse).
		const tracePriors: TracePrior[] | null = trace ? [] : null
		const traceRepairs: TraceRepair[] | null = trace ? [] : null
		const recordRepair = (pass: TraceRepairPass, before: string[], after: string[]): void => {
			if (!traceRepairs) return

			if (before.length === after.length && before.every((label, i) => label === after[i])) return
			traceRepairs.push({ pass, before, after })
		}
		// TraceRepair before/after are PER-PIECE (index-aligned with `pieces`). Token-count-preserving
		// passes can read labels 1:1, but the span bridge MERGES fragments (dropping later tokens), so
		// labels are projected back onto pieces via char offsets: each piece carries the label of the
		// token covering its start. Keeps the alignment contract true for every pass.
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
		// `applied` reports EFFECT (see TracePrior): a composed prior counts only if any cell is nonzero.
		const matrixHasBias = (m: readonly (readonly number[])[]): boolean => m.some((row) => row.some((v) => v !== 0))

		// Address-system conventions (#511 Tier A): resolve which system's rules apply — caller-pinned
		// system, or the model's own locale-head detection under a high confidence bar. Null = no
		// constraints; the parse below is byte-identical to the pre-conventions path.
		const conventionsOpt = opts?.addressSystemConventions ?? this.cfg.addressSystemConventions
		// The resolved system code drives the conventions row below (the `forbiddenTags` emission mask +
		// the `postcodePattern` snap-repair). null when conventions are off → no system, no constraints
		// (byte-stable). "auto" reads the model's locale head; a pinned SystemCode wins.
		const detectedSystem: SystemCode | null =
			conventionsOpt === undefined
				? null
				: conventionsOpt === "auto"
					? (detectAddressSystem(localeLogits)?.system ?? null)
					: conventionsOpt
		const conventions = conventionsForSystem(detectedSystem)
		const systemSource: "off" | "auto" | "pinned" =
			conventionsOpt === undefined ? "off" : conventionsOpt === "auto" ? "auto" : "pinned"

		const queryShapePrior = opts?.queryShape
			? buildEmissionPriors(opts.queryShape, pieces, this.labels, {
					biasScale: opts.queryShapeBiasScale ?? 1.0,
					inputText: text,
				})
			: undefined
		let emissions = queryShapePrior ? addEmissionMatrix(logits, queryShapePrior) : logits

		tracePriors?.push({ kind: "queryShape", applied: queryShapePrior !== undefined && matrixHasBias(queryShapePrior) })

		const fstPrior = opts?.fst
			? buildFSTEmissionPriors(opts.fst, pieces, this.labels, {
					biasScale: opts.fstBiasScale ?? 1.0,
					...(opts.fstImportanceLengthScaleMode
						? { importanceLengthScaleMode: opts.fstImportanceLengthScaleMode }
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

		// Stage 2.7 span proposer (#518, M2+M3): typed span proposals consumed as phrase priors.
		// DEFAULT ON since 2026-06-12 (operator ruling): an omitted config builds the codex lexicon
		// lazily with the frozen measured scales; `spanProposer: false` (config or per-parse) is the
		// proposer-free baseline. Disabled = byte-stable (no proposals computed).
		const configured = this.cfg.spanProposer === false ? undefined : (this.cfg.spanProposer ?? this.defaultProposer())
		const proposerCfg = (opts?.spanProposer ?? true) ? configured : undefined
		const spanProposals: ProposedSpan[] = proposerCfg ? proposeSpans(text, proposerCfg.lexicon) : []

		if (spanProposals.length > 0) {
			emissions = addEmissionMatrix(emissions, buildSpanProposalPriors(spanProposals, pieces, this.labels, proposerCfg))
		}
		tracePriors?.push({ kind: "spanProposer", applied: spanProposals.length > 0 })

		// (defaultProposer lives below decode helpers — one lazy build per classifier instance.)

		// Placetype-pair prior (placetype-pair-prior arc, Tasks 4-5): retrieval-augmented complement to the
		// encoder — see placetype-pair-prior.ts for the full windowing/matching contract. Config-level
		// default set by loadFromWeights (Task 5's country-gated construction); per-call opts override it,
		// same "opts ?? cfg default" shape as bridgePunctuationGaps/enforceWordConsistency below. Default
		// OFF (neither set → byte-stable). Composed BEFORE the conventions mask so an ungrammatical tag it
		// might bias toward still gets masked out.
		const placetypePairOpt = opts?.placetypePair ?? this.cfg.placetypePair
		const placetypePairPrior = placetypePairOpt
			? buildPlacetypePairPriors(placetypePairOpt, pieces, this.labels)
			: undefined

		if (placetypePairPrior) {
			emissions = addEmissionMatrix(emissions, placetypePairPrior)
		}
		tracePriors?.push({
			kind: "placetypePair",
			applied: placetypePairPrior !== undefined && matrixHasBias(placetypePairPrior),
		})

		// Conventions emission mask: tags that are ungrammatical in the detected system are removed
		// from the decoder's vocabulary outright (-1e9 ≈ log 0). Copy-on-mask — `emissions` may alias
		// `logits`, which the per-token confidence below reads unmasked.
		let conventionsMaskApplied = false

		if (conventions?.forbiddenTags?.length) {
			const forbidden = new Set<number>()

			for (const tag of conventions.forbiddenTags) {
				const b = this.labels.indexOf(`B-${tag}`)
				const i = this.labels.indexOf(`I-${tag}`)

				if (b >= 0) {
					forbidden.add(b)
				}

				if (i >= 0) {
					forbidden.add(i)
				}
			}

			if (forbidden.size > 0) {
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
					}).path
				: emissions.map((row) => argmaxSoftmax(row).idx)

		// The trace's `path` is the DECODER's output — snapshot before the word-consistency healing
		// below reassigns labelIndices (the healing itself is visible as a `wordConsistency` repair).
		const decodedPath = trace ? [...labelIndices] : null

		// Per-word BIO consistency repair (#727 + the admin-token fragmentation class). Opt-in — default
		// OFF → byte-identical. Heals words whose pieces disagree (e.g. `VERMONT`→VER[loc]+MONT[region],
		// `Lozère`→Loz[loc]+ère[region]) via a confidence-weighted vote over the post-prior emissions; a
		// word whose pieces already agree is untouched. See word-consistency.ts.
		let healedConfidence: Map<number, number> | null = null

		const wordConsistency = opts?.enforceWordConsistency ?? this.cfg.enforceWordConsistency ?? false

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
				// Healed words carry the vote's mean p(type) (length-invariant); unchanged pieces keep
				// the model's per-piece softmax confidence.
				confidence: healedConfidence?.get(i) ?? probs[idx]!,
			}
		})

		// Postcode repair runs when the caller asks for it OR the detected system declares a postcode
		// shape (#511 Tier A): a span that is a sub-match of a shape-valid string is exactly the
		// snap-only truncation class the pass exists for ("47110" decoded as "4711" + a digit-split).
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

		// Punctuation-gap span bridging (v4.4.0 corrective — see span-bridge.ts): merge same-tag
		// fragments split at unlabeled punctuation ("P.O. Box" decoding as P + O + Box). Opt-in,
		// declared in the ship config like the conventions mask. When the span proposer ran, its
		// ANNOTATION/QUOTED boundaries become merge-crossing constraints (M2's second half).
		if (opts?.bridgePunctuationGaps ?? this.cfg.bridgePunctuationGaps) {
			const blockedSpans = spanProposals.filter((p) => p.kind === "ANNOTATION_SPAN" || p.kind === "QUOTED_SPAN")
			// The bridge MERGES tokens (later fragments are dropped), so both snapshots go through the
			// per-piece projection — a merged span's label lands on every piece it covers, keeping
			// before/after index-aligned with `pieces` per the TraceRepair contract.
			const before = traceRepairs ? labelsPerPiece(tokens) : []
			tokens = bridgePunctuationGaps(text, tokens, blockedSpans.length > 0 ? { blockedSpans } : undefined)

			if (traceRepairs) {
				recordRepair("spanBridge", before, labelsPerPiece(tokens))
			}
		}

		return {
			tokens,
			logits,
			pieces,
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
	 * Guard against a silent label/emission shape overrun. When the model emits MORE logits per token than the configured
	 * label vocabulary (e.g. a Stage 3 bundle loaded with the default Stage 2 labels), viterbi indexes past the
	 * transition matrix and dies with an opaque `Cannot read properties of undefined (reading '0')`. Fail fast here with
	 * a message that names the contract the caller violated.
	 *
	 * The opposite shape (model narrower than labels) is intentionally permitted — STAGE2_BIO_LABELS prefix-extends
	 * STAGE1_BIO_LABELS so a Stage 1 model loaded with Stage 2 labels decodes correctly via the first 15 logits. See
	 * labels.ts for the contract.
	 */
	private assertEmissionWidth(logits: readonly number[][]): void {
		if (logits.length === 0) return
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

/** Result of `parseWithLogits` — tree + raw material for per-span logit aggregation. */
export interface ParseWithLogitsResult {
	tree: AddressTree
	logits: number[][]
	pieces: Array<{ start: number; end: number }>
}

/**
 * Per-call opts for `parse()`. Threading a precomputed `QueryShape` here turns on the soft-prior bias path in the
 * Viterbi decoder (Stage 2.4 boundary → Stage 3 encoder integration).
 */
export interface ParseOpts {
	/**
	 * Precomputed `QueryShape` for this input (from `@mailwoman/query-shape`'s `computeQueryShape`). Known-format hits in
	 * the shape produce additive emission biases toward the matching BIO label. Typed structurally — no runtime
	 * dependency on `@mailwoman/query-shape`.
	 */
	queryShape?: QueryShapeLike
	/**
	 * Maximum bias magnitude in log-odds units. Default 1.0 — adds up to ~e^1 ≈ 2.7× odds to the favored label.
	 * Confidence-scaled, so a 0.6-confidence format hit gets +0.6 max bias.
	 */
	queryShapeBiasScale?: number
	/**
	 * Pre-built FST gazetteer matcher. When provided, gazetteer matches produce additive emission biases.
	 */
	fst?: FSTMatcherLike
	/** Bias magnitude for FST gazetteer matches. Default 1.0. */
	fstBiasScale?: number
	/** Match-length scaling mode for the FST importance bias (#1142). Default `both`. */
	fstImportanceLengthScaleMode?: ImportanceLengthScaleMode
	/**
	 * Pre-built street-morphology FST matcher. When provided, street-type affixes (Avenue, rue, Calle, Straße, …) produce
	 * additive emission biases toward `street_prefix`/`street_suffix` on the matched tokens AND toward `street` / away
	 * from `dependent_locality` on the adjacent name tokens. Closes the v0.6.1 dependent_locality vacuum; see
	 * `docs/articles/concepts/street-supplement-architecture.md` for the layered design.
	 */
	fstStreetMorphology?: FSTMatcherLike
	/** Override bias magnitudes for the morphology prior. */
	fstStreetMorphologyOpts?: StreetMorphologyPriorOpts
	/**
	 * When true, run the deterministic postcode regex repair pass (v0.7 #35) on the decoded label sequence before
	 * tree-building. Detects postcode-shaped substrings (GB/CA/NL/US/FR/… patterns) and snaps/adds the postcode span to
	 * the matched shape, fixing the SentencePiece-fragmentation failures catalogued in the 2026-05-29 postcode
	 * diagnostic. Off by default — opt-in until the v0.7 gate confirms it. See `./postcode-repair.ts`.
	 */
	postcodeRepair?: boolean

	/**
	 * Per-word BIO consistency repair (#727 + the admin-token fragmentation class). Overrides the classifier's
	 * `enforceWordConsistency` config default for this parse. Pass a `WordConsistencyOpts` object to enable with the
	 * confidence gates; `true` = the ungated vote. See word-consistency.ts.
	 */
	enforceWordConsistency?: boolean | WordConsistencyOpts

	/**
	 * When true, run the deterministic secondary-unit regex repair pass on the decoded label sequence before
	 * tree-building. Detects designator-shaped substrings ("Apt 4B", "Ste 12", "Unit 9400", bare "#104", …) and
	 * snaps/adds the unit span, fixing the unit-drop weakness the three-arena capability eval surfaced (postal
	 * secondary-unit 0% neural). Off by default — opt-in until the v0.7.2 arena re-run quantifies its delta. See
	 * `./unit-repair.ts`.
	 */
	unitRepair?: boolean
	/**
	 * When true AND the input is detected ALL-CAPS (registry/compliance data like `214 JONES RD, ELKHART, TX 75839`),
	 * title-case the input before the model sees it. The model trains on mixed-case text, so all-caps is partly OOD — it
	 * drops/mis-bounds tokens (#690: `PALESTINE` → locality `ALESTINE`; all-caps locality 3/5 vs title-case 5/5).
	 * Detection-gated, so MIXED-case input is untouched (byte-stable). Off by default. On all-caps input the output
	 * values are title-cased (the SHOUTING is normalized away — better, and the resolver name-matches case-insensitively
	 * regardless).
	 */
	normalizeCase?: boolean
	/**
	 * Optional span-confidence calibrator (task #59). When provided, each decoded span's `conf=` is mapped through it
	 * (isotonic lookup table → calibrated probability of correctness). OPT-IN — omit for the byte-stable default softmax
	 * confidence. Build one via `createCalibrator` (`@mailwoman/core/decoder`) from
	 * `data/eval/calibration/isotonic-<locale>-<version>.json`.
	 */
	calibrate?: Calibrator
	/** Per-parse override of the config-level `bridgePunctuationGaps` (see that doc). */
	bridgePunctuationGaps?: boolean
	/**
	 * Per-parse switch for the config-level `spanProposer` (see that doc). `false` disables the configured proposer for
	 * this parse; `true`/omitted runs it when configured. Cannot enable the stage without a configured lexicon.
	 */
	spanProposer?: boolean
	/**
	 * Address-system conventions enforcement (#511 Tier A / #478's rules-as-constraints slice).
	 *
	 * - `"auto"` — detect the system from the model's locale head (`locale_logits` output, v1.1.0+ exports; silently no-ops
	 *   on models without it) and apply that system's codex conventions: forbidden tags become a hard emission mask
	 *   before Viterbi, and a conventions postcode shape enables the snap-only postcode repair pass.
	 * - A `SystemCode` (`"fr"`, `"us"`, …) — apply that system's conventions unconditionally (callers that already know the
	 *   locale, e.g. the pipeline's BCP-47 region).
	 * - Omit — byte-stable default: no detection, no mask (pre-#511 behavior).
	 *
	 * The detection threshold is deliberately high (0.8): the mask must never fire on a guess. Measured motivation: the
	 * 2026-06-10 v1.1.0 gate, where US suffix logic fired inside French parses (`street_suffix: "Rue"`) and digit-splits
	 * corrupted leading FR postcodes.
	 */
	addressSystemConventions?: "auto" | SystemCode

	/**
	 * Placetype-pair emission bias (placetype-pair-prior arc, Task 4). When provided, contiguous word windows (1..3 words
	 * — see `placetype-pair-prior.ts`'s `WINDOW_MAX_WORDS` docstring for the measured distribution that set the ceiling)
	 * are probed against a PIX1 pair index of (child, parent) place-name pairs harvested from a real address register
	 * (the Task-3 GB shard: PPD `CITY`/ `DISTRICT`). A window that resolves against some OTHER, disjoint window anywhere
	 * in the input gets an additive bias toward the pair's resolved `ComponentTag` — e.g. "Shoreditch" biased toward
	 * `dependent_locality` when "London" also appears in the input, because the index has recorded ("shoreditch",
	 * "london") → `dependent_locality`.
	 *
	 * Country-agnostic at the API surface: this module does no country gating itself — the caller is responsible for
	 * passing the index built for the input's locale (a GB-built index probed against a US address will simply never
	 * match, composing harmlessly).
	 *
	 * Default OFF: an omitted field produces a zero matrix, byte-identical to every parse before this task. Evidence:
	 * rung-3 gate (2026-07-22) measured 100% recall / 0.0% false-positive rate at δ=6.0 on the probe set that motivated
	 * this prior — the real `pair-index-gb.bin` artifact (Task 3) ships that delta in its header, so `biasScale` below
	 * exists only as a fallback for a hand-built `PairIndexLike` test double that omits `delta`. The runtime-flag
	 * register row for turning this on by default in the pipeline lands in Task 7, not here — this field is the plumbing,
	 * not the ship decision.
	 */
	placetypePair?: PlacetypePairPriorOpts
}

/**
 * Loud-degrade warning for the `loadFromWeights` soft-feed (#718 D1) — the Node mirror of neural-web's
 * `warnOnUnfedTrainedChannels`. Fired ONCE per channel per process: a model-card that declares a channel REQUIRED,
 * paired with a package that didn't ship (or could not parse) its data, runs that channel OFF. Structural fallback (the
 * parse still works), loud console (a silently anchor-OFF anchor-trained model is the #566/#685 OOD crater this fix
 * exists to surface).
 */
const warnedUnfedChannels = new Set<string>()
function warnUnfedChannel(channel: "anchor" | "gazetteer" | "country", detail: string): void {
	if (warnedUnfedChannels.has(channel)) return
	warnedUnfedChannels.add(channel)
	console.error(
		`[mailwoman/neural] loadFromWeights: model-card declares the ${channel} channel REQUIRED but ${detail} — ` +
			`running ${channel}-OFF, parses degraded (train/inference mismatch). Ship the ${channel} artifact in the ` +
			`weights package (postcode-<cc>.bin / anchor-lexicon-v1.json), or pass an explicit lookup.`
	)
}

function argmaxSoftmax(row: number[]): { idx: number; conf: number } {
	let maxIdx = 0
	let maxVal = row[0]!

	for (let i = 1; i < row.length; i++) {
		if (row[i]! > maxVal) {
			maxVal = row[i]!
			maxIdx = i
		}
	}
	let sumExp = 0

	for (const v of row) {
		sumExp += Math.exp(v - maxVal)
	}
	const conf = 1 / sumExp

	return { idx: maxIdx, conf }
}

/** Element-wise add two square matrices. Used to compose the structural mask + learned transitions. */
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
