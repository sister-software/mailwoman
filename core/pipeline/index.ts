// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
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
export { HARD_PLACE_COUNTRY_SAFELIST, hardCountryFor, runPipeline } from "./runtime-pipeline.js"
export { aggregateSpanLogits } from "./span-logit-aggregation.js"
export type { SpanBounds, TokenPiece } from "./span-logit-aggregation.js"
export { EMPTY_SPAN_PROPOSER_LEXICON, proposeSpans } from "./span-proposer.js"
export type { ProposedSpan, ProposedSpanKind, SpanProposerLexicon } from "./span-proposer.js"
export type {
	AddressClassifier,
	ClassifierOpts,
	FstMatcherLike,
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
