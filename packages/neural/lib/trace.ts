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
 * Every prior kind the decode path records, in the order it records them; `"placetypeCensus"`
 * only observes and adds no emission bias, so its record always has `applied: false`.
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
 * One prior kind from {@linkcode TRACE_PRIOR_KINDS}.
 */
export type TracePriorKind = (typeof TRACE_PRIOR_KINDS)[number]

/**
 * One prior's effect on a decode; the trace has one record for every kind.
 */
export interface TracePrior {
	kind: TracePriorKind

	/**
	 * Whether this prior changed any emission; a configured prior that found no match reports `false`.
	 */
	applied: boolean

	/**
	 * The probe path that produced the `placetypePair` bias — comma-delimited segments, the adjacent
	 * pair in comma-free text, or the opt-in sliding window — present only on an applied record.
	 */
	probePath?: "segment" | "anchored" | "window"

	/**
	 * The census entry for each parent name the pair probe looked up, present on the
	 * `placetypeCensus` record only when a census is loaded.
	 */
	census?: PlacetypeCensusObservation[]

	/**
	 * The number of distinct parent names probed against the census, the denominator for
	 * {@link TracePrior.census}; an empty `census` with a positive count means the census held none of them.
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
 * One repair pass that changed labels, with per-piece label arrays index-aligned
 * with `pieces`; passes that changed no label are omitted.
 */
export interface TraceRepair {
	pass: TraceRepairPass
	before: string[]
	after: string[]
}

/**
 * A tokenizer piece as fed to the model, in a JSON-serializable shape.
 */
export interface TracePiece {
	piece: string
	id: number
	start: number
	end: number
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
	 * The locale head's output, index-aligned with {@link NeuralParseTrace.localeCountries}.
	 *
	 * It is absent for models without a locale head.
	 */
	localeLogits?: number[]

	/**
	 * The semi-Markov head's per-span type scores, indexed as `spanScores[token][length - 1][type]`.
	 *
	 * It is absent when the model exports none.
	 * The type order comes from the bundle's `semi-crf-transitions.json`.
	 */
	spanScores?: number[][][]

	/**
	 * The country code for each {@link NeuralParseTrace.localeLogits} index.
	 *
	 * It is present if and only if `localeLogits` is present, so consumers never hardcode the order.
	 */
	localeCountries?: string[]

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
	decode: "viterbi" | "argmax"
	repairs: TraceRepair[]

	/**
	 * The final tokens, matching those `parse()` builds its tree from.
	 */
	tokens: DecoderToken[]
}
