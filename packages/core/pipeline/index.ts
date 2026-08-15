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

export {
	COARSE_PLACER_ANCHOR_WEIGHT,
	HARD_PLACE_COUNTRY_SAFELIST,
	hardCountryFor,
	STREET_CONTEXT_POSITIVE_SCALE,
	streetContextGateFor,
	ZEROED_MORPHOLOGY_OPTS,
	isBareLocalityTree,
	isBarePostcodeTree,
	runPipeline,
} from "./runtime-pipeline.ts"

export { aggregateSpanLogits } from "./span-logit-aggregation.ts"
export type { SpanBounds, TokenPiece } from "./span-logit-aggregation.ts"
export { EMPTY_SPAN_PROPOSER_LEXICON, proposeSpans } from "./span-proposer.ts"
export type { ProposedSpan, ProposedSpanKind, SpanProposerLexicon } from "./span-proposer.ts"
export { deriveInputMode, PipelineFaultStage, QueryIntentCode, WORD_CONSISTENCY_SHIP_DEFAULT } from "./types.ts"

export type {
	AddressClassifier,
	ClassifierOpts,
	FSTMatcherLike,
	InputMode,
	LocaleHint,
	LocaleTag,
	MachinePreferences,
	NormalizedInputLite,
	PhraseGrouper,
	PhraseKind,
	PhraseProposal,
	PipelineFault,
	PipelineOpts,
	PipelineResult,
	PipelineTiming,
	PlacetypePairPassthrough,
	POIIntent,
	POIIntentOutcome,
	POIResult,
	QueryIntentMarker,
	QueryKind,
	QueryKindResult,
	QueryShapeLite,
	RuntimePipelineStages,
	UserLocation,
} from "./types.ts"
