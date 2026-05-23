/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Convenience factory that wires the default runtime-pipeline stages together.
 *
 *   Consumers who want the full happy-path (normalize → QueryShape → classify → resolve) can call
 *   `createRuntimePipeline({ classifier, resolver })` and get a one-call entry point. Stages with
 *   no production-ready implementation today (locale gate, kind classifier) use the coordinator's
 *   stubbed defaults.
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
import { normalize } from "@mailwoman/normalize"
import { computeQueryShape } from "@mailwoman/query-shape"

export interface CreateRuntimePipelineOpts {
	/** The Stage 3 classifier — typically a `NeuralAddressClassifier`. */
	classifier?: RuntimePipelineStages["classifier"]
	/** The Stage 6 resolver — typically a `WofResolver` from `@mailwoman/resolver-wof-sqlite`. */
	resolver?: RuntimePipelineStages["resolver"]
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
		classifier: opts.classifier,
		resolver: opts.resolver,
		detectLocale: opts.detectLocale,
	}

	return (raw: string, runOpts?: PipelineOpts) => runPipeline(raw, stages, runOpts)
}

// Re-export the types so consumers don't need to import from both `mailwoman` and `@mailwoman/core/pipeline`.
export type {
	AddressClassifier,
	LocaleHint,
	NormalizedInputLite,
	PipelineOpts,
	PipelineResult,
	PipelineTiming,
	QueryKind,
	QueryKindResult,
	QueryShapeLite,
	RuntimePipelineStages,
} from "@mailwoman/core/pipeline"
