/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { SystemCode } from "@mailwoman/codex"
import type { DecoderToken } from "@mailwoman/core/decoder"

import type { PlacetypeCensusObservation } from "#placetype/pair-prior"
import type { SoftFeatureChannel } from "#soft-features"

/**
 * Lists every prior kind the decode path records, in the order it produces them.
 *
 * `"placetypeCensus"` is an observation rather than an emission prior,
 * so its record never reports `applied`.
 */
export const TRACE_PRIOR_KINDS = [
	"queryShape",
	"fst",
	"streetMorphology",
	"spanProposer",
	"placetypePair",
	"placetypeCensus",
	"conventionsMask",
] as const

/**
 * Names one prior kind from {@linkcode TRACE_PRIOR_KINDS}.
 */
export type TracePriorKind = (typeof TRACE_PRIOR_KINDS)[number]

/**
 * Records whether one prior took part in a decode; the trace carries one record for every kind.
 *
 * `applied` reports effect rather than configuration, so a configured prior
 * that matched nothing reports `false`.
 */
export interface TracePrior {
	kind: TracePriorKind

	/**
	 * Whether this prior changed any emission.
	 *
	 * It is always `false` for `"placetypeCensus"`, which observes but writes no emissions.
	 */
	applied: boolean

	/**
	 * The probe path that produced the `placetypePair` bias: comma-delimited segments,
	 * the comma-free adjacent pair, or the opt-in sliding window.
	 * It is present only on an applied `placetypePair` record.
	 */
	probePath?: "segment" | "anchored" | "window"

	/**
	 * What the census knew about each parent surface the pair probe looked up,
	 * present on `placetypeCensus` only when a census is loaded.
	 */
	census?: PlacetypeCensusObservation[]

	/**
	 * The number of distinct parent surfaces probed against the census, hit or miss,
	 * which is the denominator for {@link TracePrior.census}.
	 *
	 * An empty `census` with a positive count means the census knew none of those parents,
	 * not that they have no children.
	 */
	censusProbedParents?: number
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
 * Records one repair pass that changed labels, as per-piece BIO label sequences
 * before and after, index-aligned with `pieces`.
 * Passes that changed nothing are omitted.
 */
export interface TraceRepair {
	pass: TraceRepairPass
	before: string[]
	after: string[]
}

/**
 * A tokenizer piece as fed to the model — `TokenizedPiece`, kept structural for JSON.
 */
export interface TracePiece {
	piece: string
	id: number
	start: number
	end: number
}

/**
 * Holds the full trace of one `traceParse` call, from tokenizer pieces through
 * emissions, decode, and repairs.
 */
export interface NeuralParseTrace {
	/**
	 * The text the model saw, after case normalization.
	 */
	text: string

	/**
	 * Whether case normalization changed the input.
	 */
	caseNormalized: boolean
	pieces: TracePiece[]

	/**
	 * The postcode-anchor channel as fed to the model, absent when the channel was not fed.
	 */
	anchor?: SoftFeatureChannel

	/**
	 * The gazetteer channel as fed to the model after suppression, absent when the channel was not fed.
	 */
	gazetteer?: SoftFeatureChannel

	/**
	 * The country-lexicon channel as fed to the model, absent when the channel was not fed.
	 */
	country?: SoftFeatureChannel

	/**
	 * The raw model emissions before any prior, indexed as `logits[token][label]`.
	 */
	logits: number[][]

	/**
	 * The locale head's output, index-aligned with {@link NeuralParseTrace.localeCountries}
	 * and absent on models without the head.
	 */
	localeLogits?: number[]

	/**
	 * The semi-Markov head's per-span type scores, indexed as `spanScores[token][length - 1][type]`,
	 * and absent when the model exports none.
	 *
	 * The type axis comes from the weights bundle's `semi-crf-transitions.json`.
	 */
	spanScores?: number[][][]

	/**
	 * The country code for each {@link NeuralParseTrace.localeLogits} index,
	 * copied from the producing model so consumers never hardcode the order.
	 * It is present exactly when `localeLogits` is.
	 */
	localeCountries?: string[]

	/**
	 * The address system whose conventions applied, or null when conventions were off
	 * or no system cleared the bar.
	 */
	detectedSystem: SystemCode | null

	/**
	 * How {@link NeuralParseTrace.detectedSystem} was chosen: conventions off,
	 * locale-head detection, or a caller pin.
	 */
	systemSource: "off" | "auto" | "pinned"
	priors: TracePrior[]

	/**
	 * The matrix the decoder ran on, after priors and masks, which equals `logits` when nothing fired.
	 */
	emissions: number[][]

	/**
	 * The label vocabulary, index-aligned with the inner dimension of `logits` and `emissions`.
	 *
	 * That dimension may be narrower than this list when an older-stage model emits
	 * only a prefix of the labels, but never wider.
	 */
	labels: string[]

	/**
	 * The decoder's label index per piece, captured before the word-consistency vote and every repair pass.
	 *
	 * Those changes appear in `repairs`, and the final labels are on `tokens`.
	 */
	path: number[]
	decode: "viterbi" | "argmax"
	repairs: TraceRepair[]

	/**
	 * The final tokens, identical to what `parse()` builds its tree from.
	 */
	tokens: DecoderToken[]
}
