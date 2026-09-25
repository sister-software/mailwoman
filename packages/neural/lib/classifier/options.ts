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
	 * Set either this or `charEncoder`.
	 */
	tokenizer?: MailwomanTokenizer

	/**
	 * The character vocabulary and encoder interface for a character-input model.
	 *
	 * The runner must implement `inferChars`.
	 */
	charEncoder?: { vocabulary: CharVocabulary; interface: CharEncoderInterface }
	runner: NeuralRunner

	/**
	 * The label vocabulary in the order the model emits it.
	 *
	 * It defaults to the Stage 2 BIO labels.
	 * Stage 1 labels are a prefix of Stage 2, so a Stage 1 model also decodes correctly under the default.
	 */
	labels?: readonly string[]

	/**
	 * The decoding strategy, which defaults to `viterbi`.
	 *
	 * Viterbi decoding applies the BIO structural mask, so it never emits an orphan `I-*` label.
	 * Argmax decoding labels each piece independently and is meant for debugging.
	 */
	decode?: "viterbi" | "argmax"

	/**
	 * Learned CRF transition scores as a `labels.length` × `labels.length` matrix,
	 * added to the structural BIO mask.
	 */
	transitions?: number[][]

	/**
	 * Learned start-of-sequence transition scores per label.
	 *
	 * These scores replace the structural BIO start mask.
	 */
	startTransitions?: number[]

	/**
	 * Learned end-of-sequence transition scores per label.
	 *
	 * These scores replace the structural BIO end mask.
	 */
	endTransitions?: number[]

	/**
	 * The semi-Markov segment-transition grammar from `semi-crf-transitions.json`, exposed as `spanGrammar`.
	 *
	 * `loadFromWeights` sets it when the bundle includes the file.
	 */
	semiCRFGrammar?: SemiCRFTransitions

	/**
	 * The path to the per-locale FST gazetteer (`fst-<locale>.bin`) in the resolved weights package.
	 *
	 * The classifier only stores the path.
	 * The runtime pipeline loads the file into `ParseOpts.fst`.
	 */
	fstPath?: PathBuilderLike

	/**
	 * The path to the street-morphology FST (`fst-street-morphology.bin`) beside the resolved weights.
	 */
	streetMorphologyPath?: string

	/**
	 * The path to the loaded `model.onnx`, reported through `resolvedWeights`.
	 *
	 * Weight resolution tries several locations, so the caller's options do not reveal which model loaded.
	 */
	modelPath?: string

	/**
	 * The resolution step that produced `modelPath`: `explicit`, `cache:<package>`,
	 * `package:<package>`, or `overlay:<locale>`.
	 */
	weightsSource?: string

	/**
	 * The postcode-anchor lookup for a model trained with the `anchor_features`
	 * and `anchor_confidence` inputs.
	 */
	postcodeAnchorLookup?: AnchorLookup

	/**
	 * The substrings the anchor channel looks up, read from the model card's `requires.anchor.span_mode`.
	 *
	 * It defaults to `alnum-run`.
	 * Only a model trained against a lookup with letter-containing keys uses `shaped`.
	 */
	postcodeAnchorSpanMode?: AnchorSpanMode

	/**
	 * The gazetteer lexicon for a model trained with the `gazetteer_features`
	 * and `gazetteer_confidence` inputs.
	 *
	 * It marks candidate tags such as country, region and PO box.
	 */
	gazetteerLexicon?: GazetteerLexicon

	/**
	 * The country-surface lexicon for a model trained with the `country_features`
	 * and `country_confidence` inputs.
	 *
	 * `suppressGazetteerNearPostcode` leaves this channel unchanged.
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
	 * Whether to zero the gazetteer channel on pieces next to a postcode-anchor hit.
	 *
	 * It needs both `gazetteerLexicon` and `postcodeAnchorLookup`.
	 * Set it only for a model trained with the matching `data.gazetteer_choreography`,
	 * because other models never saw the zeroed input.
	 */
	suppressGazetteerNearPostcode?: boolean

	/**
	 * The default address-system conventions mode.
	 * See `ParseOpts.addressSystemConventions`.
	 */
	addressSystemConventions?: "auto" | SystemCode

	/**
	 * Whether to merge adjacent same-tag spans separated only by short punctuation, as in "P.O.
	 * Box".
	 *
	 * The model splits these spans because the corpus label format cannot mark punctuation inside a span.
	 */
	bridgePunctuationGaps?: boolean

	/**
	 * The span proposer configuration.
	 *
	 * When omitted, the classifier builds a default config from the codex lexicon.
	 * The value `false` disables the proposer.
	 *
	 * Proposals add emission priors, and annotation and quoted spans block punctuation-bridge merges.
	 */
	spanProposer?: SpanProposerConfig | false

	/**
	 * The default placetype-pair prior options.
	 * `ParseOpts.placetypePair` overrides them per parse.
	 *
	 * `loadFromWeights` sets them only when the weights include a `pair-index-<cc>.bin`
	 * for the locale's country.
	 */
	placetypePair?: PlacetypePairPriorOpts

	/**
	 * The default placetype census, which adds observations to the `placetypeCensus` trace record.
	 *
	 * The census never changes the decode.
	 * It is probed only while tracing with the placetype-pair prior active.
	 */
	placetypeCensus?: PlacetypeCensusLike

	/**
	 * The default for the repair that gives every piece of a whitespace-delimited
	 * word one tag by a confidence-weighted vote.
	 *
	 * When omitted, the classifier uses `WORD_CONSISTENCY_SHIP_DEFAULT`.
	 * The repair never runs on the character path.
	 */
	enforceWordConsistency?: boolean | WordConsistencyOpts
}

/**
 * Configures the span proposer.
 * See `NeuralAddressClassifierConfig.spanProposer`.
 */
export interface SpanProposerConfig extends SpanProposalPriorOpts {
	/**
	 * The designator vocabulary for `proposeSpans`, built with `buildCodexSpanLexicon`.
	 */
	lexicon: SpanProposerLexicon
}

/**
 * The result of `parseWithLogits`: the tree plus the raw per-piece logits and piece offsets.
 */
export interface ParseWithLogitsResult {
	tree: AddressTree
	logits: number[][]
	pieces: Array<{ start: number; end: number }>
}

/**
 * Per-call options for `parse()`.
 *
 * An option set here overrides the classifier's configured default for that call.
 */
export interface ParseOpts {
	/**
	 * A precomputed query shape whose known-format hits add emission biases toward the matching BIO label.
	 */
	queryShape?: QueryShapeLike

	/**
	 * The maximum query-shape bias in log-odds, which defaults to 1.
	 *
	 * Each hit's bias is scaled by its confidence.
	 */
	queryShapeBiasScale?: number

	/**
	 * The input register, which defaults to `fragmented`.
	 *
	 * The `formatted` mode withholds the street-type and locality-surface lexicons
	 * because those channels help fragments and hurt full-address parses.
	 */
	inputMode?: "fragmented" | "formatted"

	/**
	 * The FST gazetteer matcher whose matches add emission biases.
	 */
	fst?: FSTMatcherLike

	/**
	 * The bias magnitude for FST gazetteer matches, which defaults to 1.
	 *
	 * @internal Evaluation harnesses set it. The runtime pipeline does not.
	 */
	fstBiasScale?: number

	/**
	 * The match-length scaling mode for the FST importance bias, which defaults to `suppression`.
	 *
	 * @internal Evaluation harnesses set it.
	 */
	fstImportanceLengthScaleMode?: ImportanceLengthScaleMode

	/**
	 * The multiplier on the positive FST bias when a matched place name sits in a
	 * street position, such as next to a street type.
	 *
	 * The FST prior defaults it to 0.25, and the runtime pipeline sets 0.
	 * It applies only when both `fst` and `fstStreetMorphology` are set.
	 *
	 * @internal
	 */
	fstStreetContextPositiveScale?: number

	/**
	 * Whether the FST street-context check runs, which defaults to true.
	 *
	 * Pass `false` to keep the street-morphology prior without the check.
	 *
	 * @internal
	 */
	fstStreetContextRequirement?: boolean

	/**
	 * The street-morphology FST matcher.
	 *
	 * The prior biases matched street-type affixes toward `street_prefix` or `street_suffix`.
	 * It biases adjacent name tokens toward `street` and away from `dependent_locality`.
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
	 * Whether to snap or add secondary-unit spans such as "Apt 4B", "Ste 12" or "#104" after decoding.
	 * It defaults to false.
	 */
	unitRepair?: boolean

	/**
	 * Whether to title-case all-caps ASCII input before inference, which defaults to true.
	 *
	 * The model trains on mixed-case text.
	 * Mixed-case input is left unchanged, and values from all-caps input come out title-cased.
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
	 * Whether to run the configured span proposer for this parse, which defaults to true.
	 *
	 * The value `true` cannot enable a proposer that the config disabled.
	 */
	spanProposer?: boolean

	/**
	 * The address-system conventions to enforce.
	 *
	 * The value `auto` detects the system from the model's locale head, and a `SystemCode` pins it.
	 * Enforcement masks the system's forbidden tags before Viterbi and runs postcode repair
	 * when the system defines a postcode pattern.
	 *
	 * Detection acts only at a probability of 0.8 or higher and has no effect
	 * on a model without a locale head.
	 */
	addressSystemConventions?: "auto" | SystemCode

	/**
	 * A per-parse override of the config's `placetypePair`.
	 * The value `false` disables the prior for this call.
	 *
	 * The prior biases a place name toward the tag that the pair index recorded for it next to another
	 * name in the input, such as "Shoreditch" toward `dependent_locality` when "London" also appears.
	 * The index matches only input from the country it was built for.
	 */
	placetypePair?: PlacetypePairPriorOpts | false

	/**
	 * A per-parse override of the config's `placetypeCensus`.
	 * The value `false` disables the census for this call.
	 *
	 * The census changes only what `traceParse` records.
	 */
	placetypeCensus?: PlacetypeCensusLike | false
}
