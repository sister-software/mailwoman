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

import type { SoftFeatureChannel } from "./soft-features.ts"

/**
 * The emission priors the decode path may compose, in application order. The ORDERED constant is the single source for
 * "every kind" — the decode path's push sites and the empty-input return both produce records in exactly this order,
 * and the trace test asserts against it, so adding a prior without its participation record is a test failure, not a
 * silent omission.
 */
export const TRACE_PRIOR_KINDS = ["queryShape", "fst", "streetMorphology", "spanProposer", "conventionsMask"] as const

export type TracePriorKind = (typeof TRACE_PRIOR_KINDS)[number]

/**
 * One prior's participation record: present for every kind. `applied` reports EFFECT, not configuration — true only
 * when the composed prior actually carried a nonzero bias (or the mask removed at least one label). A configured source
 * that matched nothing reports `false`, so "why didn't my prior move the emissions" is answerable from the trace
 * alone.
 */
export interface TracePrior {
	kind: TracePriorKind
	applied: boolean
}

/** The post-decode repair passes, in application order. */
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

/** A tokenizer piece as fed to the model — `TokenizedPiece`, kept structural for JSON. */
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
	/** The text the model actually saw (post case-normalize). */
	text: string
	/** True when case normalization changed the input (`normalizeInputCase`, #690). */
	caseNormalized: boolean
	pieces: TracePiece[]
	/** Postcode-anchor channel exactly as fed (post-choreography). Absent = channel not fed. */
	anchor?: SoftFeatureChannel
	/** Gazetteer channel exactly as fed (post-suppression). Absent = channel not fed. */
	gazetteer?: SoftFeatureChannel
	/** Raw model emissions, pre-prior — `logits[tokenIdx][labelIdx]`. */
	logits: number[][]
	/** Locale-head output, index-aligned with `localeCountries`. Absent on models without the head. */
	localeLogits?: number[]
	/**
	 * The locale-head axis: the country code each `localeLogits` index means, serialized from the producing model's own
	 * `LOCALE_COUNTRIES` so consumers never hardcode the order (the PLACETYPE_ORDER dual-maintenance class — a retrained
	 * head that adds or reorders classes would otherwise silently mislabel every downstream gauge). Present iff
	 * `localeLogits` is.
	 */
	localeCountries?: string[]
	/** Address system whose conventions applied, or null when conventions were off / below the bar. */
	detectedSystem: SystemCode | null
	/** How `detectedSystem` was chosen: conventions off, locale-head auto-detect, or caller-pinned. */
	systemSource: "off" | "auto" | "pinned"
	priors: TracePrior[]
	/** The post-prior, post-mask matrix viterbi actually decoded over. Equals `logits` when nothing fired. */
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
	/** The final tokens — identical to what `parse()` builds its tree from. */
	tokens: DecoderToken[]
}
