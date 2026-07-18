/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Runtime pipeline coordinator — see `STAGES.md` for the full contract.
 */

export { reconcileSpans } from "./reconcile.ts"
export type {
	ClassifierCandidate,
	ParentChainLookup,
	ParseTree,
	ReconcileInputs,
	ReconcileOpts,
	ResolverCandidatesLookup,
	ScoreBreakdown,
} from "./reconcile.ts"
export { HARD_PLACE_COUNTRY_SAFELIST, hardCountryFor, isBareLocalityTree, runPipeline } from "./runtime-pipeline.ts"
export { aggregateSpanLogits } from "./span-logit-aggregation.ts"
export type { SpanBounds, TokenPiece } from "./span-logit-aggregation.ts"
export { EMPTY_SPAN_PROPOSER_LEXICON, proposeSpans } from "./span-proposer.ts"
export type { ProposedSpan, ProposedSpanKind, SpanProposerLexicon } from "./span-proposer.ts"
export { WORD_CONSISTENCY_SHIP_DEFAULT } from "./types.ts"
export type {
	AddressClassifier,
	ClassifierOpts,
	FSTMatcherLike,
	LocaleHint,
	LocaleTag,
	NormalizedInputLite,
	PhraseGrouper,
	PhraseKind,
	PhraseProposal,
	PipelineOpts,
	PipelineResult,
	PipelineTiming,
	POIIntent,
	POIIntentOutcome,
	QueryKind,
	QueryKindResult,
	QueryShapeLite,
	RuntimePipelineStages,
	UserLocation,
} from "./types.ts"
