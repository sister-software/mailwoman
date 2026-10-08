/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { SYSTEM_CODES, type SystemCode } from "@mailwoman/codex"
import type { AddressTree, Calibrator } from "@mailwoman/core/decoder"
import type {
	CaseNormalization,
	PlacetypePairSelection,
	SpanProposerLexicon,
	StageSource,
	WordConsistencySetting,
} from "@mailwoman/core/pipeline"
import type { PathBuilderLike } from "path-ts"
import { z } from "zod"

import type { AddressSystemTable } from "#address-system"
import type { AnchorLookup, AnchorSpanMode } from "#anchor-inference"
import type { CharEncoderInterface, CharVocabulary } from "#char-encoder"
import type { NeuralRunner } from "#classifier"
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

/**
 * Configures a neural address classifier.
 *
 * Options cover the model runner, tokenizer or character encoder, decode grammar,
 * optional lexicons and priors.
 */
export interface NeuralAddressClassifierConfig {
	/**
	 * The SentencePiece tokenizer for a subword model.
	 * Set either this or `charEncoder`.
	 */
	tokenizer?: MailwomanTokenizer

	/**
	 * The character vocabulary and encoder interface for a character-input model.
	 * Its runner must implement `inferChars`.
	 */
	charEncoder?: { vocabulary: CharVocabulary; interface: CharEncoderInterface }
	runner: NeuralRunner

	/**
	 * The label vocabulary in the order the model emits it, defaulting to the Stage
	 * 2 BIO labels, of which the Stage 1 labels are a prefix.
	 */
	labels?: readonly string[]

	/**
	 * The decoding strategy, defaulting to `viterbi`, which applies the BIO structural mask
	 * so it never emits an orphan `I-*` label.
	 */
	decode?: "viterbi" | "argmax"

	/**
	 * Learned CRF transition scores as a `labels.length` × `labels.length` matrix,
	 * added to the structural BIO mask.
	 */
	transitions?: number[][]

	/**
	 * Learned start-of-sequence transition scores per label, replacing the structural BIO start mask.
	 */
	startTransitions?: number[]

	/**
	 * Learned end-of-sequence transition scores per label, replacing the structural BIO end mask.
	 */
	endTransitions?: number[]

	/**
	 * The semi-Markov segment-transition grammar from `semi-crf-transitions.json`,
	 * set by `loadFromWeights` when the bundle includes the file.
	 */
	semiCRFGrammar?: SemiCRFTransitions

	/**
	 * Path to the per-locale FST gazetteer (`fst-<locale>.bin`) in the resolved weights package.
	 * The runtime pipeline loads it into `ParseOpts.fst`.
	 */
	fstPath?: PathBuilderLike

	/**
	 * The path to the street-morphology FST (`fst-street-morphology.bin`) beside the resolved weights.
	 */
	streetMorphologyPath?: string

	/**
	 * The path to the loaded `model.onnx`, reported through `resolvedWeights`
	 * because weight resolution tries several locations.
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
	 * The substrings the anchor channel looks up, read from the model card's
	 * `requires.anchor.span_mode` and defaulting to `alnum-run`.
	 */
	postcodeAnchorSpanMode?: AnchorSpanMode

	/**
	 * The gazetteer lexicon for a model trained with the `gazetteer_features` and
	 * `gazetteer_confidence` inputs, marking candidate tags such as country, region and PO box.
	 */
	gazetteerLexicon?: GazetteerLexicon

	/**
	 * Country-surface lexicon for a model trained with the `country_features`
	 * and `country_confidence` inputs.
	 *
	 * `suppressGazetteerNearPostcode` leaves this lexicon unchanged.
	 */
	countryLexicon?: CountryLexicon

	/**
	 * The street-type evidence lexicon for a model trained with the `street_type_*` inputs,
	 * withheld when `ParseOpts.inputMode` is `formatted`.
	 */
	streetTypeLexicon?: GazetteerLexicon

	/**
	 * The locality-surface evidence lexicon for a model trained with the `locality_surface_*`
	 * inputs, withheld when `ParseOpts.inputMode` is `formatted`.
	 */
	localitySurfaceLexicon?: GazetteerLexicon

	/**
	 * Whether to zero the gazetteer channel on pieces next to a postcode-anchor hit,
	 * needing both `gazetteerLexicon` and `postcodeAnchorLookup` and set only for a
	 * model trained with the matching `data.gazetteer_choreography`.
	 */
	suppressGazetteerNearPostcode?: boolean

	/**
	 * The default address-system conventions mode.
	 *
	 * It defaults to `"off"`.
	 * See {@link AddressSystemConventions}.
	 */
	addressSystemConventions?: AddressSystemConventions

	/**
	 * The model's address-system ids, from its card's `address_systems` field.
	 *
	 * A graph with a `locale_hint` input requires it, because the "no hint" id is a property of the model.
	 */
	addressSystems?: AddressSystemTable

	/**
	 * Whether to merge adjacent same-tag spans separated only by short punctuation.
	 *
	 * The model splits these spans because the corpus label format cannot mark punctuation inside a span.
	 */
	bridgePunctuationGaps?: boolean

	/**
	 * The span proposer.
	 *
	 * `"auto"` (the default) builds one from the codex lexicon, `"none"` disables it,
	 * and a config object replaces it.
	 *
	 * Its proposals add emission priors and annotation and quoted spans block punctuation-bridge merges.
	 */
	spanProposer?: StageSource<SpanProposerConfig>

	/**
	 * The default placetype-pair prior options, overridden per parse by `ParseOpts.placetypePair`
	 * and set by `loadFromWeights` only when the weights include a `pair-index-<cc>.bin`.
	 */
	placetypePair?: PlacetypePairPriorOpts

	/**
	 * Default placetype census.
	 *
	 * It never changes decoding and is probed only while tracing with the placetype-pair prior active.
	 */
	placetypeCensus?: PlacetypeCensusLike

	/**
	 * The default for the repair that gives every piece of a whitespace-delimited word one
	 * tag by a confidence-weighted vote, defaulting to `WORD_CONSISTENCY_SHIP_DEFAULT`
	 * and never running on the character path.
	 */
	enforceWordConsistency?: WordConsistencySetting
}

/**
 * Which address-system conventions a parse enforces.
 *
 * - `"off"` applies no conventions.
 * - `"auto"` detects the system from the model's locale head at a probability of 0.8 or higher.
 * - A `SystemCode` pins the system.
 */
export type AddressSystemConventions = "off" | "auto" | SystemCode

/**
 * The span proposer for one parse.
 *
 * - `"inherit"` uses the config's `spanProposer`.
 * - `"auto"` uses the default codex proposer, even when the config disabled it.
 * - `"none"` disables the proposer.
 * - A config object replaces the config's proposer.
 */
export type SpanProposerSelection = "inherit" | StageSource<SpanProposerConfig>

/**
 * The placetype census for one parse.
 *
 * - `"inherit"` uses the config's `placetypeCensus`.
 * - `"off"` disables the census.
 * - A census replaces the config's.
 */
export type PlacetypeCensusSelection = "inherit" | "off" | PlacetypeCensusLike

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
 * Per-call options for `parse()`, each overriding the classifier's configured default for that call.
 */
export interface ParseOpts {
	/**
	 * A precomputed query shape whose known-format hits add emission biases toward the matching BIO label.
	 */
	queryShape?: QueryShapeLike

	/**
	 * The maximum query-shape bias in log-odds, defaulting to 1 and scaled per hit by its confidence.
	 */
	queryShapeBiasScale?: number

	/**
	 * The input register, defaulting to `fragmented`, where `formatted` withholds the street-type
	 * and locality-surface lexicons because those channels help fragments and hurt full-address parses.
	 */
	inputMode?: "fragmented" | "formatted"

	/**
	 * The FST gazetteer matcher whose matches add emission biases.
	 */
	fst?: FSTMatcherLike | null

	/**
	 * The bias magnitude for FST gazetteer matches, defaulting to 1.
	 *
	 * @internal
	 */
	fstBiasScale?: number

	/**
	 * The match-length scaling mode for the FST importance bias, defaulting to `suppression`.
	 *
	 * @internal
	 */
	fstImportanceLengthScaleMode?: ImportanceLengthScaleMode

	/**
	 * The multiplier on the positive FST bias when a matched place name sits in a street
	 * position, defaulted to 0.25 by the FST prior and 0 by the runtime pipeline.
	 *
	 * @internal
	 */
	fstStreetContextPositiveScale?: number

	/**
	 * Whether the FST street-context check runs, defaulting to true so `false` keeps
	 * the street-morphology prior without the check.
	 *
	 * @internal
	 */
	fstStreetContextRequirement?: boolean

	/**
	 * Street-morphology FST matcher.
	 *
	 * Its prior biases matched street-type affixes toward `street_prefix`
	 * or `street_suffix`, and adjacent name tokens toward `street`.
	 */
	fstStreetMorphology?: FSTMatcherLike

	/**
	 * Overrides for the street-morphology prior's bias magnitudes.
	 */
	fstStreetMorphologyOpts?: StreetMorphologyPriorOpts

	/**
	 * Whether to snap or add postcode spans matching a known shape after decoding,
	 * also run whenever the detected address system declares a postcode shape.
	 */
	postcodeRepair?: boolean

	/**
	 * A per-parse override of the config's `enforceWordConsistency`, where an options object
	 * sets the vote thresholds, `{}` runs the unthresholded vote and `"off"` skips it.
	 */
	enforceWordConsistency?: WordConsistencySetting

	/**
	 * Whether to snap or add secondary-unit spans such as "Apt 4B", "Ste 12"
	 * or "#104" after decoding, defaulting to false.
	 */
	unitRepair?: boolean

	/**
	 * How to treat letter case before inference, defaulting to `"title-case"`,
	 * which title-cases all-caps ASCII input since the model trains on mixed-case text.
	 * Mixed-case input is left unchanged.
	 */
	caseNormalization?: CaseNormalization

	/**
	 * A calibrator that maps each decoded span's confidence to a calibrated probability
	 * of correctness, omitted to keep the raw softmax confidence.
	 */
	calibrate?: Calibrator

	/**
	 * A per-parse override of the config's `bridgePunctuationGaps`.
	 */
	bridgePunctuationGaps?: boolean

	/**
	 * The span proposer for this parse.
	 *
	 * The default `"inherit"` uses the config's.
	 * See {@link SpanProposerSelection}.
	 */
	spanProposer?: SpanProposerSelection

	/**
	 * The address-system conventions to enforce for this parse.
	 *
	 * The default `"inherit"` uses the config's.
	 * See {@link AddressSystemConventions}.
	 */
	addressSystemConventions?: "inherit" | AddressSystemConventions

	/**
	 * The ISO 3166-1 alpha-2 country the caller expects the address to be in,
	 * such as the country a user is searching from.
	 *
	 * A model trained with a locale hint reads it as evidence it can overrule.
	 * Other models ignore it.
	 */
	localeHint?: string

	/**
	 * Per-parse selection of the placetype-pair prior.
	 *
	 * The default `"inherit"` uses the config's `placetypePair`, `"off"` disables the prior,
	 * and an options object replaces the config's.
	 *
	 * The prior biases a place name toward the tag the pair index recorded beside another input name.
	 */
	placetypePair?: PlacetypePairSelection<PlacetypePairPriorOpts>

	/**
	 * The placetype census for this parse.
	 *
	 * The default `"inherit"` uses the config's.
	 * This changes only what `traceParse` records.
	 */
	placetypeCensus?: PlacetypeCensusSelection
}

/**
 * Schema for {@link AddressSystemConventions}.
 */
export const AddressSystemConventionsSchema = z.union([
	z.enum(["off", "auto"]),
	z.enum(SYSTEM_CODES as [SystemCode, ...SystemCode[]]),
])

/**
 * Reads an address-system conventions mode from a command-line or card string.
 *
 * @throws When the value is not `"off"`, `"auto"` or a known system code.
 */
export function parseAddressSystemConventions(value: string): AddressSystemConventions {
	const result = AddressSystemConventionsSchema.safeParse(value)

	if (!result.success) {
		throw new Error(
			`unknown address-system conventions mode "${value}": expected "off", "auto" or one of ${SYSTEM_CODES.join(", ")}`
		)
	}

	return result.data
}

/**
 * How a loader sets a behavior that the model card declares.
 *
 * - `"declared"` (the default) follows the card, and a card that does not
 *   declare the behavior leaves it off.
 * - `"on"` and `"off"` replace the card's declaration, a deliberate departure from how the model trained.
 */
export const ModelCardToggleSchema = z.enum(["declared", "on", "off"])

export type ModelCardToggle = z.infer<typeof ModelCardToggleSchema>

/**
 * How a loader sets the address-system conventions: `"declared"` (the default) follows
 * the card, and any {@link AddressSystemConventions} mode replaces it.
 */
export const ConventionsSettingSchema = z.union([z.literal("declared"), AddressSystemConventionsSchema])

export type ConventionsSetting = z.infer<typeof ConventionsSettingSchema>

/**
 * The model-card `requires` fields that the loaders resolve through this module.
 */
export interface DeclaredModelBehavior {
	suppress_gazetteer_near_postcode?: boolean
	bridge?: { required: boolean }
	conventions?: { required: boolean; mode?: string }
}

function toggleFor(setting: ModelCardToggle, declared: boolean | undefined): boolean {
	if (setting === "declared") return declared ?? false

	return setting === "on"
}

/**
 * Whether a loader zeroes the gazetteer channel next to postcode-anchor hits.
 *
 * Inference must match training, so the model card's `requires.suppress_gazetteer_near_postcode` decides.
 * A model whose card does not declare it was trained without the choreography, so it is off.
 *
 * Every loader (Node, scorer, browser) resolves the setting here.
 */
export function gazetteerSuppressionFor(
	setting: ModelCardToggle,
	declared: DeclaredModelBehavior | null | undefined
): boolean {
	return toggleFor(setting, declared?.suppress_gazetteer_near_postcode)
}

/**
 * Whether a loader merges same-tag spans split by short punctuation.
 *
 * The model card's `requires.bridge` decides, and a card that does not declare it leaves bridging off.
 *
 * Every loader (Node, scorer, browser) resolves the setting here.
 */
export function punctuationBridgingFor(
	setting: ModelCardToggle,
	declared: DeclaredModelBehavior | null | undefined
): boolean {
	return toggleFor(setting, declared?.bridge?.required)
}

/**
 * The address-system conventions mode a loader configures.
 *
 * A card that requires conventions supplies its `mode`, defaulting to `"auto"`.
 * A card that does not require them leaves conventions `"off"`.
 *
 * Every loader (Node, scorer, browser) resolves the setting here.
 *
 * @throws When the card declares a mode that is not a known conventions mode.
 */
export function addressSystemConventionsFor(
	setting: ConventionsSetting,
	declared: DeclaredModelBehavior | null | undefined
): AddressSystemConventions {
	if (setting !== "declared") return setting

	const conventions = declared?.conventions

	if (!conventions?.required) return "off"

	return parseAddressSystemConventions(conventions.mode ?? "auto")
}
