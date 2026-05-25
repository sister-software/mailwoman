/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Runtime pipeline coordinator — see `STAGES.md` for the full contract.
 */

export { reconcileSpans } from "./reconcile.js"
export type {
	ClassifierCandidate,
	ParentChainLookup,
	ParseTree,
	ReconcileInputs,
	ReconcileOpts,
	ResolverCandidatesLookup,
	ScoreBreakdown,
} from "./reconcile.js"
export { runPipeline } from "./runtime-pipeline.js"
export { aggregateSpanLogits } from "./span-logit-aggregation.js"
export type { SpanBounds, TokenPiece } from "./span-logit-aggregation.js"
export type {
	AddressClassifier,
	LocaleHint,
	LocaleTag,
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
	UserLocation,
} from "./types.js"
