/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { SystemCode } from "@mailwoman/codex"
import type { AddressTree, Calibrator } from "@mailwoman/core/decoder"
import type { SpanProposerLexicon } from "@mailwoman/core/pipeline"
import type { PathBuilderLike } from "path-ts"

import type { AnchorLookup, AnchorSpanMode } from "#anchor-inference"
import type { CharEncoderInterface, CharVocabulary } from "#char-encoder"
import type { NeuralRunner } from "#classifier/index"
import type { CountryLexicon } from "#country-inference"
import type { FSTMatcherLike, ImportanceLengthScaleMode } from "#fst-prior"
import type { GazetteerLexicon } from "#gazetteer-inference"
import type { PlacetypeCensusLike } from "#placetype/census"
import type { PlacetypePairPriorOpts } from "#placetype/pair-prior"
import type { QueryShapeLike } from "#query-shape-prior"
import type { SemiCRFTransitions } from "#semi-markov-decode"
import type { SpanProposalPriorOpts } from "#span/proposal-prior"
import type { StreetMorphologyPriorOpts } from "#street-morphology-prior"
import type { MailwomanTokenizer } from "#tokenizer"
import type { WordConsistencyOpts } from "#word-consistency"

/**
 * Configures a neural address classifier: the model runner, its tokenizer or character
 * encoder, the decode grammar, and the optional lexicons and priors.
 */
export interface NeuralAddressClassifierConfig {
	/**
	 * The SentencePiece tokenizer for a subword model.
	 *
	 * Set either this or `charEncoder`; a char-path model has no SentencePiece vocabulary.
	 */
	tokenizer?: MailwomanTokenizer

	/**
	 * The character vocabulary and encoder interface for a char-path model, whose units are code points.
	 *
	 * The runner must implement `inferChars`.
	 */
	charEncoder?: { vocabulary: CharVocabulary; interface: CharEncoderInterface }
	runner: NeuralRunner

	/**
	 * The label vocabulary in the order the model emits it.
	 *
	 * Defaults to the Stage 2 BIO labels, which extend Stage 1 at the same indices,
	 * so a Stage 1 model also decodes correctly under the default.
	 */
	labels?: readonly string[]

	/**
	 * The decoding strategy, default `viterbi`.
	 *
	 * `viterbi` decodes under the BIO structural mask, so no orphan `I-*` label survives.
	 * `argmax` labels each piece independently, can emit invalid sequences, and is meant only for debugging.
	 */
	decode?: "viterbi" | "argmax"

	/**
	 * Learned CRF transition scores, a `labels.length` × `labels.length` matrix
	 * added to the structural BIO mask.
	 */
	transitions?: number[][]

	/**
	 * Learned start-of-sequence transition score per label.
	 *
	 * It replaces the structural BIO start mask rather than adding to it.
	 */
	startTransitions?: number[]

	/**
	 * Learned end-of-sequence transition score per label.
	 *
	 * It replaces the structural BIO end mask rather than adding to it.
	 */
	endTransitions?: number[]

	/**
	 * The semi-Markov segment-transition grammar from `semi-crf-transitions.json`,
	 * exposed as `spanGrammar` for the span head's name-evidence rerank.
	 *
	 * `loadFromWeights` sets it when the bundle ships the file; a pre-v3 bundle has none.
	 */
	semiCRFGrammar?: SemiCRFTransitions

	/**
	 * The path to the per-locale FST gazetteer (`fst-<locale>.bin`) in the resolved weights package.
	 *
	 * The classifier carries only the path; the runtime pipeline deserializes it into `ParseOpts.fst`.
	 */
	fstPath?: PathBuilderLike

	/**
	 * The path to the locale-general street-morphology FST (`fst-street-morphology.bin`)
	 * beside the resolved weights.
	 *
	 * The runtime pipeline's street-context check loads it instead of rebuilding
	 * it from the libpostal dictionaries.
	 */
	streetMorphologyPath?: string

	/**
	 * The path to the `model.onnx` this instance loaded, reported through `resolvedWeights`.
	 *
	 * Weight resolution falls through several locations, so a caller cannot infer
	 * which model answered from the options it passed.
	 */
	modelPath?: string

	/**
	 * The resolution step that produced `modelPath`: `explicit`, `cache:<package>`,
	 * `package:<package>`, or `overlay:<locale>`.
	 */
	weightsSource?: string

	/**
	 * The postcode-anchor lookup for a model trained with the anchor
	 * channel (`anchor_features`/`anchor_confidence`).
	 *
	 * Omit it for other models.
	 */
	postcodeAnchorLookup?: AnchorLookup

	/**
	 * Which substrings the anchor channel looks up, read from the model card's `requires.anchor.span_mode`.
	 *
	 * Defaults to `alnum-run`; `shaped` belongs only to a model trained against
	 * a lookup with letter-containing keys.
	 */
	postcodeAnchorSpanMode?: AnchorSpanMode

	/**
	 * The gazetteer-anchor lexicon for a model trained with the gazetteer channel
	 * (`gazetteer_features`/`gazetteer_confidence`), which paints candidate-tag
	 * clues such as country, region and PO box.
	 */
	gazetteerLexicon?: GazetteerLexicon

	/**
	 * The country-surface lexicon for a model trained with the country
	 * channel (`country_features`/`country_confidence`).
	 *
	 * Unlike the gazetteer channel, this channel is not zeroed by `suppressGazetteerNearPostcode`.
	 */
	countryLexicon?: CountryLexicon

	/**
	 * The street-type evidence lexicon for a model trained with the `street_type_*` inputs.
	 *
	 * It is withheld when `ParseOpts.inputMode` is `formatted`.
	 */
	streetTypeLexicon?: GazetteerLexicon

	/**
	 * The locality-surface evidence lexicon for a model trained with the `locality_surface_*` inputs.
	 *
	 * It is withheld when `ParseOpts.inputMode` is `formatted`.
	 */
	localitySurfaceLexicon?: GazetteerLexicon

	/**
	 * Whether to zero the gazetteer clue on pieces next to a postcode-anchor hit,
	 * which needs both `gazetteerLexicon` and `postcodeAnchorLookup`.
	 *
	 * Set it only for a model trained with the matching `data.gazetteer_choreography`;
	 * on any other model it adds train/inference skew without recovering postcode accuracy.
	 */
	suppressGazetteerNearPostcode?: boolean

	/**
	 * The default address-system conventions mode for every parse; see `ParseOpts.addressSystemConventions`.
	 */
	addressSystemConventions?: "auto" | SystemCode

	/**
	 * Whether to merge adjacent same-tag spans separated only by short punctuation, so "P.O.
	 * Box" decodes as one span.
	 *
	 * The corpus label format cannot mark punctuation inside a span, which is why
	 * the model fragments these surfaces.
	 */
	bridgePunctuationGaps?: boolean

	/**
	 * The span-proposer configuration, on by default.
	 *
	 * Omitting it builds the codex lexicon lazily with the prior's default scales,
	 * and `false` disables the proposer.
	 * Proposals become additive emission priors, and annotation and quoted spans
	 * block span-bridge merges across them.
	 */
	spanProposer?: SpanProposerConfig | false

	/**
	 * The default placetype-pair prior options, overridden per parse by `ParseOpts.placetypePair`.
	 *
	 * `loadFromWeights` sets it only when the weights ship a `pair-index-<cc>.bin`
	 * whose country matches the locale.
	 */
	placetypePair?: PlacetypePairPriorOpts

	/**
	 * The default PCN1 placetype census, which only adds observations to
	 * `traceParse`'s `placetypeCensus` record.
	 *
	 * It never changes the decode, and it is probed only while tracing with the placetype-pair prior active.
	 */
	placetypeCensus?: PlacetypeCensusLike

	/**
	 * The default for the per-word repair that forces every piece of a whitespace-delimited
	 * word to one tag by a confidence-weighted vote.
	 *
	 * Omitting it uses `WORD_CONSISTENCY_SHIP_DEFAULT`; the repair never runs on the char path.
	 */
	enforceWordConsistency?: boolean | WordConsistencyOpts
}

/**
 * Config for the Stage 2.7 span-proposer integration (see `NeuralAddressClassifierConfig.spanProposer`).
 */
export interface SpanProposerConfig extends SpanProposalPriorOpts {
	/**
	 * The designator vocabulary for `proposeSpans`, built with `buildCodexSpanLexicon`.
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
 * Per-call options for `parse()`, where a prior set here overrides the classifier's
 * configured default for that call.
 */
export interface ParseOpts {
	/**
	 * A precomputed query shape whose known-format hits add emission biases toward the matching BIO label.
	 */
	queryShape?: QueryShapeLike

	/**
	 * The maximum query-shape bias in log-odds, default 1.
	 *
	 * Each hit's bias is scaled by its confidence, so a 0.6-confidence hit adds at most 0.6.
	 */
	queryShapeBiasScale?: number

	/**
	 * The input register, default `fragmented`.
	 *
	 * `formatted` withholds the street-type and locality-surface lexicons,
	 * because those channels help fragments but damage full-address parses.
	 */
	inputMode?: "fragmented" | "formatted"

	/**
	 * The FST gazetteer matcher whose matches add emission biases.
	 */
	fst?: FSTMatcherLike

	/**
	 * The bias magnitude for FST gazetteer matches, default 1.
	 *
	 * @internal Evaluation harnesses set it to decompose the FST channel; the runtime pipeline never does.
	 */
	fstBiasScale?: number

	/**
	 * The match-length scaling mode for the FST importance bias, default `suppression`.
	 *
	 * @internal Evaluation harnesses set it to decompose the FST channel.
	 */
	fstImportanceLengthScaleMode?: ImportanceLengthScaleMode

	/**
	 * The multiplier on the positive FST bias when a matched place name sits in a
	 * street-headed position, such as next to a street type.
	 *
	 * The classifier default is 0.25, but the runtime pipeline pins 0, which suppresses the bias entirely.
	 * It applies only when both `fst` and `fstStreetMorphology` are set.
	 *
	 * @internal
	 */
	fstStreetContextPositiveScale?: number

	/**
	 * Whether the FST street-context check runs, default true.
	 *
	 * Pass `false` to keep the street-morphology prior without the check when measuring the two separately.
	 *
	 * @internal
	 */
	fstStreetContextRequirement?: boolean

	/**
	 * The street-morphology FST matcher.
	 *
	 * Matched street-type affixes are biased toward `street_prefix` or `street_suffix`,
	 * and adjacent name tokens toward `street` and away from `dependent_locality`.
	 */
	fstStreetMorphology?: FSTMatcherLike

	/**
	 * Overrides for the street-morphology prior's bias magnitudes.
	 */
	fstStreetMorphologyOpts?: StreetMorphologyPriorOpts

	/**
	 * Whether to snap or add postcode spans that match a known postcode shape after decoding.
	 *
	 * The pass also runs whenever the detected address system declares a postcode shape.
	 */
	postcodeRepair?: boolean

	/**
	 * A per-parse override of the config's `enforceWordConsistency`.
	 *
	 * An options object sets the vote thresholds, and `true` runs the unthresholded vote.
	 */
	enforceWordConsistency?: boolean | WordConsistencyOpts

	/**
	 * Whether to snap or add secondary-unit spans such as "Apt 4B", "Ste 12"
	 * or "#104" after decoding, default false.
	 */
	unitRepair?: boolean

	/**
	 * Whether to title-case all-caps ASCII input before the model sees it, default true.
	 *
	 * The model trains on mixed-case text.
	 * Mixed-case input is untouched, and values from all-caps input come out title-cased.
	 */
	normalizeCase?: boolean

	/**
	 * A calibrator that maps each decoded span's confidence to a calibrated probability of correctness.
	 *
	 * Omit it to keep the raw softmax confidence.
	 */
	calibrate?: Calibrator

	/**
	 * A per-parse override of the config's `bridgePunctuationGaps`.
	 */
	bridgePunctuationGaps?: boolean

	/**
	 * Whether to run the configured span proposer for this parse, default true.
	 *
	 * `true` cannot enable a proposer that the config disabled.
	 */
	spanProposer?: boolean

	/**
	 * The address-system conventions to enforce: `auto` detects the system from the
	 * model's locale head, and a `SystemCode` pins it.
	 *
	 * Enforcement masks the system's forbidden tags before Viterbi and runs postcode repair
	 * when the system declares a postcode shape.
	 * `auto` acts only at 0.8 confidence or higher, so the mask never fires on a guess,
	 * and it does nothing on a model without a locale head.
	 */
	addressSystemConventions?: "auto" | SystemCode

	/**
	 * A per-parse override of the config's `placetypePair`; `false` disables an
	 * auto-wired default for this call.
	 *
	 * The prior biases a place name toward the tag a pair index recorded for it alongside another name
	 * in the input, such as "Shoreditch" toward `dependent_locality` when "London" also appears.
	 * The index must be built for the input's country; an index for another country never matches.
	 */
	placetypePair?: PlacetypePairPriorOpts | false

	/**
	 * A per-parse override of the config's `placetypeCensus`; `false` disables
	 * an auto-wired default for this call.
	 *
	 * It changes only what `traceParse` records, never the decode.
	 */
	placetypeCensus?: PlacetypeCensusLike | false
}
