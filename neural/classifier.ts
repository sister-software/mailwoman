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
import { parseJSONStrict } from "@mailwoman/core/objects"
import {
	proposeSpans,
	type ProposedSpan,
	type SpanProposerLexicon,
	WORD_CONSISTENCY_SHIP_DEFAULT,
} from "@mailwoman/core/pipeline"
// SELF-REFERENCE, not a relative path: export conditions do not apply to relative specifiers, so
// `./onnx-runner.ts` bypasses the browser counterpart. The package name is what routes this.
import { DEFAULT_INTRA_OP_THREADS, type InferResult, ONNXRunner } from "@mailwoman/neural/onnx-runner"

import { detectAddressSystem, LOCALE_COUNTRIES } from "./address-system.ts"
import { type AnchorLookup, parseAnchorLookup } from "./anchor-inference.ts"
import { normalizeInputCase } from "./case-normalize.ts"
import { type CountryLexicon, parseCountryLexicon } from "./country-inference.ts"
import { buildFSTEmissionPriors, type FSTMatcherLike, type ImportanceLengthScaleMode } from "./fst-prior.ts"
import { type GazetteerLexicon, parseGazetteerLexicon } from "./gazetteer-inference.ts"
import { STAGE2_BIO_LABELS } from "./labels.ts"
import { PairIndexResolver, peekPairIndexHeader } from "./pair-index-resolver.ts"
import {
	buildPlacetypePairPriors,
	type PlacetypePairPriorOpts,
	type PlacetypePairProbeTrace,
} from "./placetype-pair-prior.ts"
import { PostcodeBinaryResolver } from "./postcode-binary-resolver.ts"
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
import { buildTrailingLocalityPriors, type TrailingLocalityPriorOpts } from "./trailing-locality-prior.ts"
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
		country?: { features: ReadonlyArray<ReadonlyArray<number>>; confidence: ReadonlyArray<number> },
		evidence?: {
			streetType?: { features: ReadonlyArray<ReadonlyArray<number>>; confidence: ReadonlyArray<number> }
			localitySurface?: { features: ReadonlyArray<ReadonlyArray<number>>; confidence: ReadonlyArray<number> }
		}
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
	/**
	 * Optional learned start-of-sequence transition scores per label.
	 */
	startTransitions?: number[]
	/**
	 * Optional learned end-of-sequence transition scores per label.
	 */
	endTransitions?: number[]
	/**
	 * #727 stage-2: the parsed semi-Markov segment-transition grammar (`semi-crf-transitions.json`), for the span head's
	 * k-best decode. `loadFromWeights` populates it when the bundle ships the sidecar; exposed via {@link spanGrammar} so
	 * the phase-4c name-evidence rerank can consume it without re-reading the file. Absent on a pre-v3 bundle.
	 */
	semiCRFGrammar?: SemiCRFTransitions
	/**
	 * Path to the per-locale FST gazetteer binary shipped in the resolved weights package (`fst-<locale>.bin`), surfaced
	 * verbatim from {@link resolveWeights} — PATH ONLY (neural has no resolver-wof-sqlite dependency; the caller's layer
	 * deserializes). Exposed via {@link NeuralAddressClassifier.fstPath} so the mailwoman runtime pipeline can auto-load
	 * the gazetteer into `opts.fst` at pipeline construction.
	 */
	fstPath?: string
	/**
	 * Path to the locale-general street-morphology FST binary shipped beside the resolved weights
	 * (`fst-street-morphology.bin`), surfaced verbatim from {@link resolveWeights} — PATH ONLY, same posture as
	 * {@link NeuralConfig.fstPath}. Exposed via {@link NeuralAddressClassifier.streetMorphologyPath} so the runtime
	 * pipeline's street-context gate (#1315) deserializes the sealed artifact instead of rebuilding it from the libpostal
	 * dictionaries per process.
	 */
	streetMorphologyPath?: string
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
	 * Optional street-type evidence lexicon (Option-A bundle, Phase 2). When set, `parse` paints per-piece street-type
	 * clues and feeds them to the runner — for bundle-trained models (exported with the
	 * `street_type_features`/`street_type_confidence` ONNX inputs). Same JSON schema + parser as the gazetteer lexicon.
	 */
	streetTypeLexicon?: GazetteerLexicon
	/**
	 * Optional locality-surface evidence lexicon (Option-A bundle) — `locality_surface_*` ONNX inputs.
	 */
	localitySurfaceLexicon?: GazetteerLexicon
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
	 * Default placetype-pair index (placetype-pair-prior arc — see `ParseOpts.placetypePair` for the full matching
	 * contract, including the probe-mode default). Set by `loadFromWeights` when the resolved weights package ships a
	 * country-matching `pair-index-<cc>.bin` (the hard country gate — see that method). Per-parse `opts.placetypePair`
	 * overrides this default; omitting both is the byte-stable no-prior default (undefined → zero matrix). `#decode`
	 * always injects the current parse's `inputText` into whichever object wins (config default or per-parse override) —
	 * see `placetype-pair-prior.ts`'s `PlacetypePairPriorOpts.inputText` — so neither this field nor a per-parse override
	 * needs to carry its own text.
	 */
	placetypePair?: PlacetypePairPriorOpts

	/**
	 * Per-word BIO consistency repair (#727 + the admin-token fragmentation class). Default off → byte-identical. When
	 * enabled, every `▁`-delimited word's pieces are forced to ONE tag by a confidence-weighted vote over the post-prior
	 * emissions (see word-consistency.ts). Pass a `WordConsistencyOpts` object to enable WITH the #727 confidence gates
	 * (floor / byte-fallback skip / slash grouping); `true` = the ungated vote. Per-parse
	 * `ParseOptions.enforceWordConsistency` overrides this default.
	 */
	enforceWordConsistency?: boolean | WordConsistencyOpts
}

/**
 * Config for the Stage 2.7 span-proposer integration (see `NeuralAddressClassifierConfig.spanProposer`).
 */
export interface SpanProposerConfig extends SpanProposalPriorOpts {
	/**
	 * Codex-backed designator vocabulary (`buildCodexSpanLexicon`).
	 */
	lexicon: SpanProposerLexicon
}

export class NeuralAddressClassifier {
	private readonly labels: readonly string[]
	private readonly decodeMode: "viterbi" | "argmax"
	private readonly transitions: number[][]
	/**
	 * Lazily-built default Stage 2.7 config (codex lexicon, frozen scales) — see `cfg.spanProposer`.
	 */
	#defaultProposerCfg: SpanProposerConfig | undefined
	private readonly startTransitions: number[]
	private readonly endTransitions: number[]
	private readonly cfg: NeuralAddressClassifierConfig

	constructor(cfg: NeuralAddressClassifierConfig) {
		this.cfg = cfg
		this.labels = cfg.labels ?? STAGE2_BIO_LABELS
		this.decodeMode = cfg.decode ?? "viterbi"
		const structural = buildBIOTransitionMask(this.labels)

		this.transitions = cfg.transitions ? addMatrices(structural, cfg.transitions) : structural
		this.startTransitions = cfg.startTransitions ?? buildBIOStartMask(this.labels)
		this.endTransitions = cfg.endTransitions ?? buildBIOEndMask(this.labels)
	}

	/**
	 * The parsed semi-Markov segment-transition grammar (`semi-crf-transitions.json`), when the loaded bundle shipped it.
	 * Consumed by the #727 phase-4c k-best name-evidence rerank; `undefined` on a pre-v3 (span-less) bundle.
	 */
	get spanGrammar(): SemiCRFTransitions | undefined {
		return this.cfg.semiCRFGrammar
	}

	/**
	 * Path to the per-locale FST gazetteer binary (`fst-<locale>.bin`) when the resolved weights package shipped one,
	 * else `undefined`. The runtime pipeline deserializes + auto-wires it as the default `opts.fst` (opt out with `fst:
	 * false` at pipeline construction); direct `classifier.parse` callers can do the same or pass their own.
	 */
	get fstPath(): string | undefined {
		return this.cfg.fstPath
	}

	/**
	 * Path to the locale-general street-morphology FST (`fst-street-morphology.bin`) when the resolved weights package
	 * (or its base) shipped one, else `undefined`. The runtime pipeline's street-context gate (#1315) deserializes it
	 * through the shared loader ladder instead of rebuilding from the libpostal dictionaries per process.
	 */
	get streetMorphologyPath(): string | undefined {
		return this.cfg.streetMorphologyPath
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
		opts: ResolveWeightsOpts & {
			postcodeAnchorLookup?: AnchorLookup
			executionProviders?: string[]
			intraOpNumThreads?: number
		} = {}
	): Promise<NeuralAddressClassifier> {
		// The sanctioned crossing into the three Node-only modules. `webpackIgnore` leaves the import
		// statement intact, so it becomes a runtime native ESM import: resolvable in Node, and never
		// followed into the browser chunk graph, where `node:fs` and `onnxruntime-node`'s binaries would
		// fail to parse. A STATIC import of any of the three would be followed, which the lint rule guards.

		/* oxlint-disable typescript/no-restricted-imports -- webpackIgnore keeps these out of the bundle */
		const [{ $public }, { resolveWeights, readLabelsFromModelCard, readCRFTransitions, readRequiredChannels }, fs] =
			await Promise.all([
				import(/* webpackIgnore: true */ "@mailwoman/core/env"),
				import(/* webpackIgnore: true */ "./weights.ts"),
				import(/* webpackIgnore: true */ "node:fs"),
			])

		/* oxlint-enable typescript/no-restricted-imports */
		const resolved: ResolvedWeights = resolveWeights(opts)

		// The vocabulary belongs to the MODEL, so an overlay that shares a base model inherits it rather than
		// restating it. A carrier package's own card describes the overlay — its version, its own artifacts —
		// and omitting `labels` there is correct; copying them in would be a second copy to go stale on the
		// next retrain. Falling back is what keeps the two facts in one place.
		const labels =
			readLabelsFromModelCard(resolved.modelCardPath) ?? readLabelsFromModelCard(resolved.baseModelCardPath)

		const crf = readCRFTransitions(resolved.crfTransitionsPath)
		// #727 stage-2: parse the span head's segment-transition grammar when the bundle ships it (v3+). Failure to parse
		// is non-fatal — the model still classifies; only the phase-4c k-best rerank goes unavailable (spanGrammar stays
		// undefined).
		let semiCRFGrammar: SemiCRFTransitions | undefined

		if (resolved.semiCRFTransitionsPath) {
			try {
				semiCRFGrammar = parseSemiCRFTransitions(
					parseJSONStrict(fs.readFileSync(resolved.semiCRFTransitionsPath, "utf8"))
				)
			} catch (error) {
				console.error(
					`[mailwoman/neural] loadFromWeights: failed to parse ${resolved.semiCRFTransitionsPath} — ` +
						`the #727 phase-4c k-best rerank is unavailable (spanGrammar undefined): ${(error as Error).message}`
				)
			}
		}

		const [tokenizer, runner] = await Promise.all([
			MailwomanTokenizer.loadFromFile(resolved.tokenizerPath),
			ONNXRunner.create(resolved.modelPath, {
				executionProviders: opts.executionProviders,
				// Cap the intra-op pool. Left unset, ORT sizes it to the core count, so N concurrent processes
				// each claim the whole machine — the multiplier behind the CLI spawn-test timeouts. Measured
				// 2026-08-03 over 120 parses: 1 thread costs 18.3 ms/parse against 9.3 for all-cores (a 97%
				// regression — the parallelism IS doing work), 2 costs 12.5, and 4 is 9.2 — flat against the
				// default while claiming a quarter of the threads. So the cap is free at 4 and expensive at 1;
				// do not "simplify" it downward without re-running that curve.
				// Explicit opt > deployment env > compromise default. The env layer exists because the right
				// value is a property of how many processes share the host, which this library cannot see.
				intraOpNumThreads: opts.intraOpNumThreads ?? $public.MAILWOMAN_INTRA_OP_THREADS ?? DEFAULT_INTRA_OP_THREADS,
			}),
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
					: parseAnchorLookup(parseJSONStrict(fs.readFileSync(resolved.anchorLookupPath.path, "utf8")))
			} catch (error) {
				warnUnfedChannel("anchor", `failed to parse ${resolved.anchorLookupPath.path}: ${(error as Error).message}`)
			}
		}

		if (declared?.anchor?.required && !(postcodeAnchorLookup && postcodeAnchorLookup.size)) {
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
				gazetteerLexicon = parseGazetteerLexicon(
					parseJSONStrict(fs.readFileSync(resolved.gazetteerLexiconPath, "utf8"))
				)
			} catch (error) {
				warnUnfedChannel("gazetteer", `failed to parse ${resolved.gazetteerLexiconPath}: ${(error as Error).message}`)
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
				countryLexicon = parseCountryLexicon(parseJSONStrict(fs.readFileSync(resolved.countryLexiconPath, "utf8")))
			} catch (error) {
				warnUnfedChannel("country", `failed to parse ${resolved.countryLexiconPath}: ${(error as Error).message}`)
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

		// Evidence-bundle lexicons (Option-A, Phase 2): same soft-feed pattern; degrade-absent for every
		// pre-bundle package. `requires`-declared enforcement arrives with the first bundle-trained card.
		let streetTypeLexicon: GazetteerLexicon | undefined

		if (resolved.streetTypeLexiconPath) {
			try {
				streetTypeLexicon = parseGazetteerLexicon(
					parseJSONStrict(fs.readFileSync(resolved.streetTypeLexiconPath, "utf8"))
				)
			} catch (error) {
				warnUnfedChannel(
					"street_type",
					`failed to parse ${resolved.streetTypeLexiconPath}: ${(error as Error).message}`
				)
			}
		}

		let localitySurfaceLexicon: GazetteerLexicon | undefined

		if (resolved.localitySurfaceLexiconPath) {
			try {
				localitySurfaceLexicon = parseGazetteerLexicon(
					parseJSONStrict(fs.readFileSync(resolved.localitySurfaceLexiconPath, "utf8"))
				)
			} catch (error) {
				warnUnfedChannel(
					"locality_surface",
					`failed to parse ${resolved.localitySurfaceLexiconPath}: ${(error as Error).message}`
				)
			}
		}

		// Placetype-pair index sibling (placetype-pair-prior arc): construct a PairIndexResolver
		// when the package shipped one for this country. HARD COUNTRY GATE — an index built for one
		// country must never bias a parse resolved for a different locale (a mismatch is a packaging bug,
		// not something to apply anyway): the index header's `country` must equal the resolved locale's
		// country subtag, or the default is skipped with a single warning naming both. Unlike the
		// anchor/gazetteer/country soft-feed channels above, there is no "declared required" fail-closed
		// case here — the prior is opt-in plumbing, so a missing/mismatched index degrades silently to the
		// byte-stable no-prior default, loud only via the gate warning.
		//
		// Header peek before construction: the country check reads ONLY the magic +
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
			} catch (error) {
				console.error(
					`[mailwoman/neural] loadFromWeights: failed to parse ${resolved.pairIndexPath}: ${(error as Error).message}`
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
			...(semiCRFGrammar ? { semiCRFGrammar } : {}),
			...(postcodeAnchorLookup ? { postcodeAnchorLookup } : {}),
			...(gazetteerLexicon ? { gazetteerLexicon } : {}),
			...(streetTypeLexicon ? { streetTypeLexicon } : {}),
			...(localitySurfaceLexicon ? { localitySurfaceLexicon } : {}),
			...(countryLexicon ? { countryLexicon } : {}),
			...(placetypePair ? { placetypePair } : {}),
			...(resolved.fstPath ? { fstPath: resolved.fstPath } : {}),
			...(resolved.streetMorphologyPath ? { streetMorphologyPath: resolved.streetMorphologyPath } : {}),
			...(suppressGazetteerNearPostcode ? { suppressGazetteerNearPostcode } : {}),
			// The card's `mode` is an open string; a non-SystemCode value degrades to a null conventions row
			// downstream (`conventionsForSystem` on an unknown code), never a throw — so the widening cast is
			// runtime-safe. An overlay card may pin a concrete system here (en-gb pins "gb", #1275) when the
			// locale head's auto detection under-fires for the bundle's own locale.
			...(addressSystemConventions
				? { addressSystemConventions: addressSystemConventions as "auto" | SystemCode }
				: {}),
		})
	}

	/**
	 * Tokenize → infer → Viterbi (or argmax) → decoder tree.
	 */
	async parse(text: string, opts?: ParseOpts): Promise<AddressTree> {
		if (!text.length) return { raw: text, roots: [] }
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
	 * (Option C joint-reconcile integration). Shares the ENTIRE decode path with `parse` (one `#decode`, #481) — repair
	 * passes included, because reconcile must consume the same tokens the argmax path serves users, under the same repair
	 * opts. `logits` stay RAW (pre-prior, pre-repair) — they are the model's emissions, not the decode's opinions.
	 */
	async parseWithLogits(text: string, opts?: ParseOpts): Promise<ParseWithLogitsResult> {
		if (!text.length) {
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

		if (!text.length) {
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
	 * `parse` and `parseWithLogits` consume this — never fork it; the 2026-06 audit found three drift surfaces across
	 * duplicated copies of this path.
	 */
	// Deliberately ONE function, long on purpose — every caller funnels through here so there is nowhere
	// for a second copy to drift.
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
		 * Present iff `trace` — the retained intermediates `traceParse` assembles.
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
		const encoded = this.cfg.tokenizer.encode(text)
		const ids = encoded.ids
		// Reassigned after inference — the runner clamps to the model's fixed sequence length and
		// `pieces` has to follow it. See the clamp below.
		let pieces = encoded.pieces
		// Soft-feature channels (#718): the postcode-anchor (#239/#240) + gazetteer-anchor (#464) clues
		// the model conditions on alongside the ids, plus the near-postcode gazetteer choreography. The
		// build + choreography is the single PURE `buildSoftFeatures` (soft-features.ts) — both this
		// decode path and the ProductionScorer feed channels identically, so there is exactly one
		// choreography. Each channel is undefined when its source is unconfigured (no-op).
		//
		// The evidence-bundle channels are REGISTER-GATED (Decision A, see ParseOpts.inputMode):
		// formatted mode withholds both lexicons so the model runs its curriculum-trained absence
		// identity — the fed channels lift fragments but damage full-address parses.
		const evidenceOn = (opts?.inputMode ?? "fragmented") === "fragmented"

		const soft = buildSoftFeatures(text, pieces, {
			postcodeAnchorLookup: this.cfg.postcodeAnchorLookup,
			gazetteerLexicon: this.cfg.gazetteerLexicon,
			countryLexicon: this.cfg.countryLexicon,
			suppressGazetteerNearPostcode: this.cfg.suppressGazetteerNearPostcode,
			streetTypeLexicon: evidenceOn ? this.cfg.streetTypeLexicon : undefined,
			localitySurfaceLexicon: evidenceOn ? this.cfg.localitySurfaceLexicon : undefined,
		})

		const { logits, localeLogits, spanScores } = await this.cfg.runner.infer(
			ids,
			soft.anchor,
			soft.gazetteer,
			soft.country,
			soft.streetType || soft.localitySurface
				? { streetType: soft.streetType, localitySurface: soft.localitySurface }
				: undefined
		)

		this.assertEmissionWidth(logits)

		// INVARIANT for everything below: one row of emissions per piece. `ONNXRunner.infer` truncates its
		// input to `fixedSeqLen` and slices `logits` to what it ran, so an untruncated `pieces` breaks that
		// pairing and every lockstep consumer indexes off the end — the token build reading `logits[i]`,
		// `enforceWordConsistency` reading `emissions[pi]`.
		//
		// The limit is reachable by ordinary input: 128 pieces is roughly 330 characters, which a
		// form-concatenated delivery address clears. Dropping the tail is the runner's existing choice made
		// visible; the alternative is throwing on a valid address. Note the tail is LOST, not deferred —
		// components past the window never reach the model at all.
		//
		// `logits.length`, not a literal 128, so this holds for any `fixedSeqLen` — including models whose
		// window differs, and non-Latin scripts that reach it at far shorter character counts.
		if (pieces.length > logits.length) {
			pieces = pieces.slice(0, logits.length)
		}

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
					// Street-context gate (#1142): reuse the morphology FST already loaded for the
					// street-morphology prior. Inert when the morphology FST isn't loaded.
					...(opts.fstStreetMorphology && opts.fstStreetContextGate !== false
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

		// Trailing-locality prior (comma-free "street + trailing city", fork B — see
		// trailing-locality-prior.ts). Opt-in; absent → byte-stable.
		const trailingLocalityPrior = opts?.trailingLocality
			? buildTrailingLocalityPriors(pieces, this.labels, {
					...opts.trailingLocality,
					// R3 (locality-present ⇒ silent) reads the CURRENT argmax — the emissions as composed so far.
					emissions: opts.trailingLocality.emissions ?? emissions,
				})
			: undefined

		if (trailingLocalityPrior) {
			emissions = addEmissionMatrix(emissions, trailingLocalityPrior)
		}

		tracePriors?.push({
			kind: "trailingLocality",
			applied: trailingLocalityPrior !== undefined && matrixHasBias(trailingLocalityPrior),
		})

		// Stage 2.7 span proposer (#518, M2+M3): typed span proposals consumed as phrase priors.
		// DEFAULT ON since 2026-06-12 (operator ruling): an omitted config builds the codex lexicon
		// lazily with the frozen measured scales; `spanProposer: false` (config or per-parse) is the
		// proposer-free baseline. Disabled = byte-stable (no proposals computed).
		const configured = this.cfg.spanProposer === false ? undefined : (this.cfg.spanProposer ?? this.defaultProposer())
		const proposerCfg = (opts?.spanProposer ?? true) ? configured : undefined
		const spanProposals: ProposedSpan[] = proposerCfg ? proposeSpans(text, proposerCfg.lexicon) : []

		if (spanProposals.length) {
			emissions = addEmissionMatrix(emissions, buildSpanProposalPriors(spanProposals, pieces, this.labels, proposerCfg))
		}

		tracePriors?.push({ kind: "spanProposer", applied: spanProposals.length > 0 })

		// (defaultProposer lives below decode helpers — one lazy build per classifier instance.)

		// Placetype-pair prior (placetype-pair-prior arc): retrieval-augmented complement to the
		// encoder — see placetype-pair-prior.ts for the full windowing/matching contract. Config-level
		// default set by loadFromWeights (its country-gated construction); per-call opts override it,
		// same "opts ?? cfg default" shape as bridgePunctuationGaps/enforceWordConsistency below. Default
		// OFF (neither set → byte-stable). Composed BEFORE the conventions mask so an ungrammatical tag it
		// might bias toward still gets masked out.
		const placetypePairOpt = opts?.placetypePair ?? this.cfg.placetypePair
		// Trace-only out-record: which probe-chain path fired (segment vs anchored vs window) — see
		// PlacetypePairProbeTrace. Only allocated when tracing, like the tracePriors list itself.
		const pairProbeTrace: PlacetypePairProbeTrace | undefined = trace ? {} : undefined

		const placetypePairResult = placetypePairOpt
			? buildPlacetypePairPriors(
					{ ...placetypePairOpt, inputText: text, probeTrace: pairProbeTrace ?? placetypePairOpt.probeTrace },
					pieces,
					this.labels
				)
			: undefined

		const placetypePairPrior = placetypePairResult?.matrix

		if (placetypePairPrior) {
			emissions = addEmissionMatrix(emissions, placetypePairPrior)
		}

		// TRANSITION-BETA: convert the prior's label-string adjustments to the decoder's index axis. Empty
		// (the overwhelmingly common case — no hit, or a beta-less index) stays `undefined` so the viterbi
		// call below is argument-identical to the pre-beta path. A label the vocabulary doesn't carry is
		// dropped, mirroring `applyWindowBias`'s own unknown-label skip.
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
			// `probePath` rides only when a bias actually landed — an applied:false record stays shape-identical to
			// every trace produced before the probe chain existed.
			...(placetypePairApplied && pairProbeTrace?.firedPath ? { probePath: pairProbeTrace.firedPath } : {}),
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
						// TRANSITION-BETA: position-scoped entry bonuses from the placetype-pair prior (undefined
						// unless a pair hit fired on a transitionBeta-carrying index). Viterbi-only by nature — the
						// argmax path has no transitions to adjust.
						...(pairTransitionAdjustments ? { transitionAdjustments: pairTransitionAdjustments } : {}),
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

		// The default is the SHIPPED configuration, deliberately — `geocode-core.ts` resolves to this same
		// constant, so a bare classifier and the production pipeline decode identically. Anything that
		// defaults differently here is a decode no user is on, and probes written against the classifier
		// will report defects the shipped path cannot reach.
		//
		// The repair upholds an invariant no valid parse can violate: the pieces of one word carry one tag.
		// `false` opts out for callers who want the raw emissions.
		const wordConsistency =
			opts?.enforceWordConsistency ?? this.cfg.enforceWordConsistency ?? WORD_CONSISTENCY_SHIP_DEFAULT

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
			tokens = bridgePunctuationGaps(text, tokens, blockedSpans.length ? { blockedSpans } : undefined)

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
 * Result of `parseWithLogits` — tree + raw material for per-span logit aggregation.
 */
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
	 * The input register (operator Decision A, 2026-07-28; canonical docs on `@mailwoman/core/pipeline`'s `InputMode`).
	 * `formatted` runs the evidence-bundle channels (street_type/locality_surface) deliberately OFF — the trained absence
	 * identity, a DECLARED ablation, not a missing feed — because the bundle lifts fragments and damages full-address
	 * parses. Default `"fragmented"` for bare library calls (today's feed-when-configured semantics); the production
	 * pipeline always passes the mode explicitly (kind-classifier-derived when the caller didn't set one). Typed
	 * structurally — no runtime dependency on `@mailwoman/core`.
	 */
	inputMode?: "fragmented" | "formatted"
	/**
	 * Pre-built FST gazetteer matcher. When provided, gazetteer matches produce additive emission biases.
	 */
	fst?: FSTMatcherLike
	/**
	 * Bias magnitude for FST gazetteer matches. Default 1.0.
	 *
	 * @internal Instrument knob (D3, ROAD_TO_MAILWOMAN_V8_1_0 §5.3) — exists so the eval harnesses can decompose the
	 *   FST channel, NOT consumer configuration. The shipped calibration is the default; `createRuntimePipeline`
	 *   consumers never set this.
	 */
	fstBiasScale?: number
	/**
	 * Match-length scaling mode for the FST importance bias (#1142). Default `suppression`.
	 *
	 * @internal Instrument knob (D3) — measurement decomposition only; the default IS the shipped calibration.
	 */
	fstImportanceLengthScaleMode?: ImportanceLengthScaleMode
	/**
	 * Positive-bias multiplier for the FST street-context gate (#1142) — applied when a matched place name sits in a
	 * syntactically street-headed position (street-type adjacency / house-number-left). Only consulted when BOTH `fst`
	 * and `fstStreetMorphology` are provided. Classifier-level default 0.25; the PIPELINE ships 0 (full suppression — D2
	 * remediation, measured 2026-07-26: homonym at exact P0 parity, golden + every other board identical to 0.25).
	 *
	 * @internal Instrument knob (D3) — measurement decomposition only; `createRuntimePipeline` pins the shipped value.
	 */
	fstStreetContextPositiveScale?: number
	/**
	 * Master switch for the street-context gate (#1142). Default true — the gate is active whenever BOTH `fst` and
	 * `fstStreetMorphology` are provided. Pass `false` to run the morphology emission prior WITHOUT the gate (the
	 * pre-gate behavior); used to decompose the two channels in measurement.
	 *
	 * @internal Instrument knob (D3) — measurement decomposition only.
	 */
	fstStreetContextGate?: boolean
	/**
	 * Pre-built street-morphology FST matcher. When provided, street-type affixes (Avenue, rue, Calle, Straße, …) produce
	 * additive emission biases toward `street_prefix`/`street_suffix` on the matched tokens AND toward `street` / away
	 * from `dependent_locality` on the adjacent name tokens. Closes the v0.6.1 dependent_locality vacuum; see
	 * `docs/articles/concepts/street-supplement-architecture.md` for the layered design.
	 */
	fstStreetMorphology?: FSTMatcherLike
	/**
	 * Override bias magnitudes for the morphology prior.
	 */
	fstStreetMorphologyOpts?: StreetMorphologyPriorOpts
	/**
	 * Trailing-locality prior (comma-free "street + trailing city" — fork B). Geometry-gated: fires only on a trailing
	 * word-span that matches a gazetteer locality by PRESENCE, with street-affix evidence before it, and never on the
	 * street name itself. Importance-free — complementary to the FST prior, and deliberately decoupled from `fst` /
	 * `fstStreetMorphology` (the fork-A lesson: broad FST bias is geometrically opposed to the street-context gate).
	 * Absent → byte-stable. See `trailing-locality-prior.ts`.
	 *
	 * ⚠ OPT-IN ONLY, deliberately never auto-wired: the prior cannot separate a trailing city from a person-name street
	 * surname ("Avenue Marceau Julien") — it regresses the #1143 bare-street population on open-vocabulary street text
	 * (measured 2026-07-25). Use only where the input register is known comma-free over notable cities.
	 *
	 * @deprecated D3 (ROAD_TO_MAILWOMAN_V8_1_0 §5.3): scheduled for deletion at the next major. Net-negative on the
	 *   held-out BAN population — the open-vocab wall no decode prior crosses. The lasting fix is training-side (#1102);
	 *   the next-major architecture (Option A, retrieval-augmented encoding) absorbs this mechanism's job.
	 */
	trailingLocality?: TrailingLocalityPriorOpts
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
	/**
	 * Per-parse override of the config-level `bridgePunctuationGaps` (see that doc).
	 */
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
	 * Per-call override for the config-level `placetypePair` default (see
	 * {@link NeuralAddressClassifierConfig.placetypePair}). Explicit `false` disables an AUTO-WIRED config default for
	 * this one call — the same typed-disable shape as {@link spanProposer} above (`SpanProposerConfig | false` at the
	 * config level; `false` per-call), applied here to the object-valued config instead of a boolean flag. The typed
	 * `false` is the ONLY real disable signal: an object-only field leaves a caller substituting a never-matching
	 * `PairIndexLike` stub (`neural/test/weights.test.ts`'s `NO_MATCH_PAIR_INDEX` idiom) — functionally equivalent but
	 * not type-checkable as intent. `opts?.placetypePair ?? this.cfg.placetypePair` (see `#decode`) resolves `false`
	 * correctly with no special case: `??` only falls through on `null`/`undefined`, never on `false`, so an explicit
	 * `false` here wins over any config default.
	 *
	 * Placetype-pair emission bias (placetype-pair-prior arc). When provided, candidates are probed against a PIX1 pair
	 * index of (child, parent) place-name pairs harvested from a real address register (the GB shard: PPD
	 * `CITY`/`DISTRICT`). A candidate that resolves against some OTHER, disjoint candidate anywhere in the input gets an
	 * additive bias toward the pair's resolved `ComponentTag` — e.g. "Shoreditch" biased toward `dependent_locality` when
	 * "London" also appears in the input, because the index has recorded ("shoreditch", "london") →
	 * `dependent_locality`.
	 *
	 * **`probeMode` — the `"auto"` probe chain (default) vs the explicit `"segment"`/`"anchored"`/`"window"` overrides.**
	 * How a "candidate" is built matters a great deal. The default `"auto"` chain (v1.1, 2026-07-24 anchored
	 * adjacent-pair design) runs the segment path when the input has ≥2 comma-delimited segments — byte-identical to
	 * explicit `"segment"` there, by construction — and the anchored-adjacent path on comma-free input (where segment
	 * mode is deterministically inert; any anchored bias is strictly additive against that zero baseline). `"segment"`
	 * (the v1 default) restricts candidates to WHOLE comma-delimited segments; `"window"` mode (contiguous 1..3-word
	 * sliding sub-segments — see `placetype-pair-prior.ts`'s `WINDOW_MAX_WORDS` docstring for the measured distribution
	 * that set that ceiling) is opt-in only. Window mode is not a default because, measured against a 6,500-row
	 * venue-confound falsifier board (real UK business names that embed a real place name — "Bitterne Charcoal Grill"
	 * embeds "Bitterne") at the real artifact's δ=6.0, it produced a **52.123% false-positive rate** (2026-07-22) against
	 * a pre-registered FP=0 bar: a sub-segment window has no venue-boundary awareness and fires just as readily inside a
	 * longer venue/business phrase as it does on a bare place name. Segment mode structurally can't make that mistake —
	 * "Bitterne Charcoal Grill" has no internal comma, so its only candidate key is the 3-word fold, which never equals a
	 * 1-word census entry. See `placetype-pair-prior.ts`'s module docstring ("Probe mode" section) for the full contract,
	 * both modes' measured trade-offs, and the re-enablement bar for window mode as a default.
	 *
	 * Country-agnostic at the API surface: this module does no country gating itself — the caller is responsible for
	 * passing the index built for the input's locale (a GB-built index probed against a US address will simply never
	 * match, composing harmlessly).
	 *
	 * Default resolution: **an omitted field does NOT unconditionally mean "no prior".** `#decode` resolves this as
	 * `opts?.placetypePair ?? this.cfg.placetypePair` — when `loadFromWeights` auto-wired a config-level default (the
	 * country-gated construction for en-gb-shaped caches), an omitted per-call field falls through to THAT default and
	 * the prior fires. The no-prior path holds only when NEITHER this field NOR the config default is set (e.g.
	 * `loadFromWeights({ locale: "en-us" })`, which ships no `pair-index-*.bin` sibling to auto-wire). Pass explicit
	 * `false` to force the prior off for one call regardless of an auto-wired config default (see this field's own doc
	 * comment above for the typed-disable contract). Evidence: rung-3 gate (2026-07-22) measured 100% recall / 0.0%
	 * false-positive rate at δ=6.0 on the curated probe set that motivated this prior. **Superseded by the shipped δ
	 * calibration** (2026-07-22): the real `pair-index-gb.bin` artifact ships δ=5.0 (a held-out register-row +
	 * venue-confound sweep, feed-8k's calibrated optimum; feed-2k calibrates to 4.5 but fails the FR-fragment
	 * bare-locality bar) in its header, so `biasScale` below exists only as a fallback for a hand-built `PairIndexLike`
	 * test double that omits `delta`.
	 */
	placetypePair?: PlacetypePairPriorOpts | false
}

/**
 * Loud-degrade warning for the `loadFromWeights` soft-feed (#718 D1) — the Node mirror of neural-web's
 * `warnOnUnfedTrainedChannels`. Fired ONCE per channel per process: a model-card that declares a channel REQUIRED,
 * paired with a package that didn't ship (or could not parse) its data, runs that channel OFF. Structural fallback (the
 * parse still works), loud console (a silently anchor-OFF anchor-trained model is the #566/#685 OOD crater this fix
 * exists to surface).
 */
const warnedUnfedChannels = new Set<string>()

function warnUnfedChannel(
	channel: "anchor" | "gazetteer" | "country" | "street_type" | "locality_surface",
	detail: string
): void {
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

/**
 * Element-wise add two square matrices. Used to compose the structural mask + learned transitions.
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
