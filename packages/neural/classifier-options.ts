/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The classifier's configuration + per-parse option contracts, split from `classifier.ts` when that file hit its
 *   max-lines ceiling for the third time in one day — these are pure types with zero behavior, and the class file
 *   re-exports them so every existing import keeps working.
 */

import type { SystemCode } from "@mailwoman/codex"
import type { AddressTree, Calibrator } from "@mailwoman/core/decoder"
import type { SpanProposerLexicon } from "@mailwoman/core/pipeline"

import type { AnchorLookup, AnchorSpanMode } from "./anchor-inference.ts"
import type { NeuralRunner } from "./classifier.ts"
import type { CountryLexicon } from "./country-inference.ts"
import type { FSTMatcherLike, ImportanceLengthScaleMode } from "./fst-prior.ts"
import type { GazetteerLexicon } from "./gazetteer-inference.ts"
import type { PlacetypeCensusLike } from "./placetype-census.ts"
import type { PlacetypePairPriorOpts } from "./placetype-pair-prior.ts"
import type { QueryShapeLike } from "./query-shape-prior.ts"
import type { SemiCRFTransitions } from "./semi-markov-decode.ts"
import type { SpanProposalPriorOpts } from "./span-proposal-prior.ts"
import type { StreetMorphologyPriorOpts } from "./street-morphology-prior.ts"
import type { MailwomanTokenizer } from "./tokenizer.ts"
import type { WordConsistencyOpts } from "./word-consistency.ts"

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
	 * Which substrings the anchor channel looks up (`AnchorSpanMode`, 2026-08-05). Defaults to `alnum-run`,
	 * byte-identical to every parse before that date; `shaped` is PAIRED like `suppressGazetteerNearPostcode` and belongs
	 * only to a model trained against a lookup with letter-bearing keys. Read from `requires.anchor.span_mode`.
	 */
	postcodeAnchorSpanMode?: AnchorSpanMode
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
	 * Default PCN1 placetype census — OBSERVABILITY ONLY. Set by `loadFromWeights` when the build-local artifact exists
	 * for the resolved locale's country (`loadPlacetypeCensus`, which documents why it is build-local and not a weights
	 * sibling). It rides the placetype-pair prior's parent-candidate probes and its ONLY effect is a `placetypeCensus`
	 * record on `traceParse`'s prior list: no emission bias, no transition adjustment, no decode change, present or
	 * absent. Consequently it does nothing when the pair prior itself is off (no index → no parent candidates to probe
	 * alongside) and nothing on a plain `parse()` (no trace to write into). Per-parse `opts.placetypeCensus` overrides;
	 * `false` disables an auto-wired default for one call.
	 */
	placetypeCensus?: PlacetypeCensusLike

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

	/**
	 * Per-call override for the config-level `placetypeCensus` default (see
	 * {@link NeuralAddressClassifierConfig.placetypeCensus}) — same typed-disable shape as {@link placetypePair}.
	 *
	 * OBSERVABILITY ONLY: whichever way this resolves, the decode is byte-identical. It selects whether `traceParse`'s
	 * `placetypeCensus` prior record carries census observations, nothing more, which is exactly what makes `false`
	 * useful — it is how a test parses the same input twice, once with the census wired and once without, and asserts the
	 * emissions/path/tokens didn't move (`placetype-census-observability.test.ts`).
	 */
	placetypeCensus?: PlacetypeCensusLike | false
}
