/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Convenience factory that wires the default runtime-pipeline stages together.
 *
 *   Consumers who want the full happy-path (normalize → QueryShape → classify → resolve) can call
 *   `createRuntimePipeline({ classifier, resolver })` and get a one-call entry point. All stages
 *   have production-ready defaults: normalize, QueryShape, locale-gate (rule-based v1), kind
 *   classifier (rule-based), phrase grouper (rule-based). Only the neural classifier and resolver
 *   need explicit injection.
 *
 *   See `docs/articles/plan/reference/STAGES.md` for the full contract.
 */

import {
	runPipeline,
	type PipelineOpts,
	type PipelineResult,
	type RuntimePipelineStages,
} from "@mailwoman/core/pipeline"
import { classifyKind as defaultClassifyKind } from "@mailwoman/kind-classifier"
import { detectLocale as defaultDetectLocale } from "@mailwoman/locale-gate"
import { normalize } from "@mailwoman/normalize"
import { groupPhrases as defaultGroupPhrases } from "@mailwoman/phrase-grouper"
import { computeQueryShape } from "@mailwoman/query-shape"

export interface CreateRuntimePipelineOpts {
	/** The Stage 3 classifier — typically a `NeuralAddressClassifier`. */
	classifier?: RuntimePipelineStages["classifier"]
	/** The Stage 6 resolver — typically a `WofResolver` from `@mailwoman/resolver-wof-sqlite`. */
	resolver?: RuntimePipelineStages["resolver"]
	/**
	 * Pre-built FST gazetteer matcher. Produces additive emission biases during neural
	 * classification.
	 */
	fst?: RuntimePipelineStages["fst"]
	/**
	 * Locale gate override — when shipped, replaces the default caller-trust stub.
	 *
	 * @see RuntimePipelineStages.detectLocale
	 */
	detectLocale?: RuntimePipelineStages["detectLocale"]
	/**
	 * Kind classifier override — when shipped, replaces the default no-fast-path stub.
	 *
	 * @see RuntimePipelineStages.classifyKind
	 */
	classifyKind?: RuntimePipelineStages["classifyKind"]
	/**
	 * Phrase grouper override (Stage 2.7). Defaults to the rule-based `@mailwoman/phrase-grouper`.
	 * v0.5.0 wires this in as a required stage; callers should normally NOT override unless they have
	 * a learned span proposer (planned for v0.5.1).
	 *
	 * @see RuntimePipelineStages.groupPhrases
	 */
	groupPhrases?: RuntimePipelineStages["groupPhrases"]
}

/**
 * Build a runtime pipeline pre-wired with the default normalize + queryShape implementations.
 *
 * Returns a function that takes raw input + per-call opts and runs the full pipeline.
 *
 * @example Const pipeline = createRuntimePipeline({ classifier: await
 * NeuralAddressClassifier.loadFromWeights({ locale: "en-US" }), resolver:
 * createWofResolver(backend), }) const result = await pipeline("350 5th Ave, New York, NY 10118", {
 * locale: "en-US" })
 */
export function createRuntimePipeline(
	opts: CreateRuntimePipelineOpts = {}
): (raw: string, runOpts?: PipelineOpts) => Promise<PipelineResult> {
	const stages: RuntimePipelineStages = {
		normalize,
		computeQueryShape,
		// Default kind classifier: rule-based from @mailwoman/kind-classifier. Caller can override.
		classifyKind: opts.classifyKind ?? defaultClassifyKind,
		// Default phrase grouper: rule-based from @mailwoman/phrase-grouper. Hard dep in v0.5.0 —
		// not an opt-in shim. The plan doc framed Stage 2.7 as backward-compatible-opt-in for the
		// v0.4.0 pipeline; we have no current users to migrate, so v0.5.0 ships it as a required
		// stage. Override only with a compatible alternative (e.g. v0.5.1's learned span proposer).
		groupPhrases: opts.groupPhrases ?? defaultGroupPhrases,
		classifier: opts.classifier,
		fst: opts.fst,
		resolver: opts.resolver,
		// Default locale gate: rule-based from @mailwoman/locale-gate. Derives locale from
		// QueryShape character class (CJK→ja-JP, Cyrillic→ru-RU, Arabic→ar) + known-format
		// hits (us_zip→en-US, fr_postcode→fr-FR, uk_postcode→en-GB). Caller-hint wins when set.
		detectLocale: opts.detectLocale ?? defaultDetectLocale,
	}

	return (raw: string, runOpts?: PipelineOpts) => runPipeline(raw, stages, runOpts)
}

// Re-export the types so consumers don't need to import from both `mailwoman` and `@mailwoman/core/pipeline`.
// `ParseOpts` lives in `@mailwoman/neural` — re-export here so callers can type-check parse options
// without reaching into internal workspace packages.
export type {
	AddressClassifier,
	ClassifierOpts,
	FstMatcherLike,
	LocaleHint,
	NormalizedInputLite,
	PhraseGrouper,
	PhraseKind,
	PhraseProposal,
	PipelineOpts,
	PipelineResult,
	PipelineTiming,
	QueryKind,
	QueryKindResult,
	QueryShapeLite,
	RuntimePipelineStages,
} from "@mailwoman/core/pipeline"
export type { ParseOpts } from "@mailwoman/neural"
