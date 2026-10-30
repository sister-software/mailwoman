/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { SystemCode } from "@mailwoman/codex"
import type { DecoderToken } from "@mailwoman/core/decoder"
import type { ChannelPins, InputMode } from "@mailwoman/core/pipeline"

import type { DecodeExplanation } from "#decode-explanation"
import type { PlacetypeCensusObservation } from "#placetype/pair-prior"
import type { SoftFeatureChannel } from "#soft-features"
import type { TokenizedPiece } from "#tokenizer"

/**
 * Every prior kind the decode path records, in the order it records them; `"placetypeCensus"`
 * only observes and adds no emission bias, so its record always has `applied: false`.
 */
export const TRACE_PRIOR_KINDS = [
	"queryShape",
	"fst",
	"anchorRegion",
	"streetMorphology",
	"spanProposer",
	"venueHead",
	"placetypePair",
	"placetypeCensus",
	"conventionsMask",
] as const

/**
 * One prior kind from {@linkcode TRACE_PRIOR_KINDS}.
 */
export type TracePriorKind = (typeof TRACE_PRIOR_KINDS)[number]

/**
 * One prior's effect on a decode.
 * The trace has one record for every kind.
 */
export interface TracePrior {
	kind: TracePriorKind

	/**
	 * Whether this prior changed any emission.
	 * A configured prior that found no match reports `false`.
	 */
	applied: boolean

	/**
	 * The probe path that produced the `placetypePair` bias — comma-delimited segments, the adjacent
	 * pair in comma-free text, or the opt-in sliding window — null unless the record applied.
	 */
	probePath: "segment" | "anchored" | "window" | null

	/**
	 * The census entry for each parent name the pair probe looked up, non-null on the
	 * `placetypeCensus` record only when a census is loaded.
	 */
	census: PlacetypeCensusObservation[] | null

	/**
	 * The number of distinct parent names probed against the census, the denominator for
	 * {@link TracePrior.census}; an empty `census` with a positive count means the census held none of them.
	 */
	censusProbedParents: number | null
}

/**
 * The post-decode repair passes, in application order.
 */
export type TraceRepairPass =
	| "wordConsistency"
	| "postcodeRepair"
	| "unitRepair"
	| "jpMunicipality"
	| "krSubregion"
	| "spanBridge"

/**
 * One repair pass that changed labels, with per-piece label arrays index-aligned
 * with `pieces`; passes that changed no label are omitted.
 */
export interface TraceRepair {
	pass: TraceRepairPass
	before: string[]
	after: string[]
}

/**
 * The full trace of one `traceParse` call, from tokenizer pieces through emissions, decoding and repairs.
 */
export interface NeuralParseTrace {
	/**
	 * The text the model saw, after case normalization.
	 */
	text: string

	caseNormalized: boolean
	pieces: TokenizedPiece[]

	/**
	 * The country the parse's tree resolved containment for: the caller's locale hint,
	 * or the locale classifier's confident country, or null.
	 *
	 * `buildAddressTree(text, tokens, { country })` reproduces the parse's tree.
	 */
	containmentCountry: string | null

	/**
	 * The postcode-anchor channel as fed to the model, null when the channel was not fed.
	 */
	anchor: SoftFeatureChannel | null

	/**
	 * The gazetteer channel as fed to the model after suppression, null when the channel was not fed.
	 */
	gazetteer: SoftFeatureChannel | null

	/**
	 * The country-lexicon channel as fed to the model, null when the channel was not fed.
	 */
	country: SoftFeatureChannel | null

	/**
	 * The street-type evidence channel as fed to the model.
	 *
	 * It is null when no lexicon is configured, on the character path, and in `formatted`
	 * input mode, because that register withholds the channel.
	 */
	streetType: SoftFeatureChannel | null

	/**
	 * The locality-surface evidence channel as fed to the model.
	 *
	 * It is null when no lexicon is configured, on the character path,
	 * in `formatted` input mode, and when the street-type lexicon matched no piece,
	 * because the runtime builds this channel only in street context.
	 */
	localitySurface: SoftFeatureChannel | null

	/**
	 * The input register the decode ran under.
	 *
	 * The register decides whether the two evidence channels were fed.
	 */
	inputMode: InputMode

	/**
	 * The channel pins the caller set for this parse, empty when every channel was fed as built.
	 *
	 * A channel pinned `off` appears in its channel field as zeros, so a reader can
	 * tell a pinned silence from one the lexicons produced.
	 */
	channelPins: ChannelPins

	/**
	 * The raw model emissions before any prior, indexed as `logits[token][label]`.
	 */
	logits: number[][]

	/**
	 * The locale head's output, index-aligned with {@link NeuralParseTrace.localeCountries}.
	 *
	 * It is null for models without a locale head.
	 */
	localeLogits: number[] | null

	/**
	 * The semi-Markov head's per-span type scores, indexed as `spanScores[token][length - 1][type]`.
	 *
	 * It is null when the model exports none.
	 * The type order comes from the bundle's `semi-crf-transitions.json`.
	 */
	spanScores: number[][][] | null

	/**
	 * The country code for each {@link NeuralParseTrace.localeLogits} index.
	 *
	 * It is non-null if and only if `localeLogits` is non-null, so consumers never hardcode the order.
	 */
	localeCountries: string[] | null

	/**
	 * The address system whose conventions applied, or null when conventions were off
	 * or no system was detected.
	 */
	detectedSystem: SystemCode | null

	/**
	 * How {@link NeuralParseTrace.detectedSystem} was chosen: conventions off,
	 * locale-head detection, or a pinned system.
	 */
	systemSource: "off" | "auto" | "pinned"
	priors: TracePrior[]

	/**
	 * The matrix the decoder ran on, after priors and masks.
	 * It equals `logits` when no prior applied.
	 */
	emissions: number[][]

	/**
	 * The label vocabulary, index-aligned with the inner dimension of `logits` and `emissions`.
	 *
	 * That dimension may be narrower than this list when an earlier-stage model
	 * emits only a prefix of the labels.
	 */
	labels: string[]

	/**
	 * The decoder's label index per piece, captured before any repair pass.
	 *
	 * Repair changes appear in `repairs`, and the final labels are on `tokens`.
	 */
	path: number[]

	/**
	 * Per piece, the decoded label's lead in `emissions` over the best other label
	 * of the same row, index-aligned with `path`.
	 *
	 * A small or negative margin marks a decision one perturbation away from flipping,
	 * where a per-token softmax can still read as confident.
	 */
	margins: number[]
	decode: "viterbi" | "argmax"

	/**
	 * The decoded path explained by the objective the decoder summed: per span,
	 * the best reading that labels the span differently and the margin to it split by term,
	 * and per applied prior, what it added and which spans it changed.
	 *
	 * It explains `path`, before repairs, and is null for empty input.
	 */
	explanation: DecodeExplanation | null
	repairs: TraceRepair[]

	/**
	 * The cardinality filter's choice when the parse ran with `cardinalityFilter`:
	 * the rank of the path it took among the 20 best, and whether every path repeated
	 * a singleton tag so the best path was kept.
	 * Absent when the filter was off.
	 */
	cardinalityFilter?: { rank: number; fellBack: boolean }

	/**
	 * The final tokens, matching those `parse()` builds its tree from.
	 */
	tokens: DecoderToken[]
}
