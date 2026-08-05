/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Parse-trace types — the serializable record of one trip through
 *   `NeuralAddressClassifier`'s decode path: what the model saw (pieces + soft-feature
 *   channels), what it believed (raw logits, locale head), what nudged it (priors), and what
 *   overrode it (repair passes). Produced by `traceParse` (classifier.ts); consumed by the docs
 *   `<ModelVisualizer>` and, later, `mailwoman parse --trace`. Spec:
 *   docs/superpowers/specs/2026-07-03-parse-trace-model-visualizer-design.md.
 *
 *   Everything here is plain JSON-serializable data by construction — no Maps, no classes, no
 *   typed arrays. The schema-snapshot test (test/trace-parse.test.ts) guards drift.
 */

import type { SystemCode } from "@mailwoman/codex"
import type { DecoderToken } from "@mailwoman/core/decoder"

import type { PlacetypeCensusObservation } from "./placetype-pair-prior.ts"
import type { SoftFeatureChannel } from "./soft-features.ts"

/**
 * The emission priors the decode path may compose, in application order. The ORDERED constant is the single source for
 * "every kind" — the decode path's push sites and the empty-input return both produce records in exactly this order,
 * and the trace test asserts against it, so adding a prior without its participation record is a test failure, not a
 * silent omission.
 *
 * `"placetypeCensus"` is the one member that is NOT an emission prior. It is the PCN1 census observability rung: it
 * rides the placetype-pair prior's parent-candidate probes, records what the census knows about each parent, and
 * composes nothing — its `applied` is `false` by construction (see {@link TracePrior.applied}). It sits directly after
 * `"placetypePair"` because that is where in the decode path it is produced, and the ordering here is production order,
 * not a claim about composition.
 */
export const TRACE_PRIOR_KINDS = [
	"queryShape",
	"fst",
	"streetMorphology",
	"trailingLocality",
	"spanProposer",
	"placetypePair",
	"placetypeCensus",
	"conventionsMask",
] as const

export type TracePriorKind = (typeof TRACE_PRIOR_KINDS)[number]

/**
 * One prior's participation record: present for every kind. `applied` reports EFFECT, not configuration — true only
 * when the composed prior actually carried a nonzero bias (or the mask removed at least one label). A configured source
 * that matched nothing reports `false`, so "why didn't my prior move the emissions" is answerable from the trace
 * alone.
 */
export interface TracePrior {
	kind: TracePriorKind
	/**
	 * Whether this prior moved anything. ALWAYS `false` on `"placetypeCensus"`, which writes no emissions at all — a
	 * `true` there would mean somebody wired a census bias into the decoder, which the 2026-08-04 assessment gates behind
	 * a calibration δ the artifact deliberately doesn't carry.
	 */
	applied: boolean
	/**
	 * `placetypePair` only, and only when `applied` is true: which candidate-construction path of the probe chain
	 * produced the bias — `"segment"` (comma-delimited segments), `"anchored"` (the comma-free adjacent-pair path), or
	 * `"window"` (the opt-in sliding window). See `placetype-pair-prior.ts`'s "Probe mode" docstring section. Absent on
	 * every other kind and whenever the prior carried no bias, so pre-existing traces are unchanged byte-for-byte.
	 */
	probePath?: "segment" | "anchored" | "window"
	/**
	 * `placetypeCensus` only: what the PCN1 census knew about each parent surface the pair prior's probe chain looked up
	 * on this input. Absent when no census artifact was loaded — the feature is then entirely inert and the record is
	 * just `{kind, applied: false}`.
	 */
	census?: PlacetypeCensusObservation[]
	/**
	 * `placetypeCensus` only: how many DISTINCT parent surfaces were probed against the census, hit or miss — the
	 * denominator for {@link census}. `0` with a census loaded means the probe chain never reached a parent candidate
	 * (e.g. a single-token input); a positive count with an empty {@link census} means the census genuinely knew none of
	 * them, which is coverage, not a claim that those parents have no children.
	 */
	censusProbedParents?: number
}

/**
 * The post-decode repair passes, in application order.
 */
export type TraceRepairPass = "wordConsistency" | "postcodeRepair" | "unitRepair" | "spanBridge"

/**
 * A repair pass that changed something: per-piece BIO label sequences before and after, index-aligned with `pieces`.
 * Passes that ran but changed nothing are omitted.
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
 * The full trace of one `traceParse` call. Field-by-field provenance lives in the spec's trace contract table; the one
 * deviation from that table is that vocab ids ride on `pieces[].id` rather than a parallel `ids` array (same
 * information, one fewer alignment invariant).
 */
export interface NeuralParseTrace {
	/**
	 * The text the model actually saw (post case-normalize).
	 */
	text: string
	/**
	 * True when case normalization changed the input (`normalizeInputCase`, #690).
	 */
	caseNormalized: boolean
	pieces: TracePiece[]
	/**
	 * Postcode-anchor channel exactly as fed (post-choreography). Absent = channel not fed.
	 */
	anchor?: SoftFeatureChannel
	/**
	 * Gazetteer channel exactly as fed (post-suppression). Absent = channel not fed.
	 */
	gazetteer?: SoftFeatureChannel
	/**
	 * Country-lexicon channel exactly as fed (#1104). Absent = channel not fed.
	 */
	country?: SoftFeatureChannel
	/**
	 * Raw model emissions, pre-prior — `logits[tokenIdx][labelIdx]`.
	 */
	logits: number[][]
	/**
	 * Locale-head output, index-aligned with `localeCountries`. Absent on models without the head.
	 */
	localeLogits?: number[]
	/**
	 * #727 stage-2: per-span type scores from the semi-Markov head — `spanScores[token][length-1][type]`. Absent on
	 * pre-v3 bundles (the model exports no `span_scores`); the type axis lives in the weights bundle's
	 * `semi-crf-transitions.json`, never hardcoded here.
	 */
	spanScores?: number[][][]
	/**
	 * The locale-head axis: the country code each `localeLogits` index means, serialized from the producing model's own
	 * `LOCALE_COUNTRIES` so consumers never hardcode the order (the PLACETYPE_ORDER dual-maintenance class — a retrained
	 * head that adds or reorders classes would otherwise silently mislabel every downstream gauge). Present iff
	 * `localeLogits` is.
	 */
	localeCountries?: string[]
	/**
	 * Address system whose conventions applied, or null when conventions were off / below the bar.
	 */
	detectedSystem: SystemCode | null
	/**
	 * How `detectedSystem` was chosen: conventions off, locale-head auto-detect, or caller-pinned.
	 */
	systemSource: "off" | "auto" | "pinned"
	priors: TracePrior[]
	/**
	 * The post-prior, post-mask matrix viterbi actually decoded over. Equals `logits` when nothing fired.
	 */
	emissions: number[][]
	/**
	 * The label vocabulary. Index-aligned with the logits/emissions inner dimension, which may be NARROWER than this list
	 * (the Stage-prefix rule: a Stage-N model loaded with Stage-N+1 labels emits only the prefix — see labels.ts +
	 * `assertEmissionWidth`). Never wider.
	 */
	labels: string[]
	/**
	 * The DECODER's label indices per piece — the raw viterbi/argmax output, captured BEFORE the word-consistency healing
	 * vote and before every token-repair pass (all of which appear in `repairs`; final labels live on `tokens`). This is
	 * what the heatmap's path outline means: the cell the decode chose, not the healed result.
	 */
	path: number[]
	decode: "viterbi" | "argmax"
	repairs: TraceRepair[]
	/**
	 * The final tokens — identical to what `parse()` builds its tree from.
	 */
	tokens: DecoderToken[]
}
