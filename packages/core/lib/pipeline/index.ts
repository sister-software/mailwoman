// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Runtime pipeline coordinator — see `STAGES.md` for the full contract.
 */

export {
	COARSE_PLACER_ANCHOR_WEIGHT,
	HARD_PLACE_COUNTRY_SAFELIST,
	hardCountryFor,
	STREET_CONTEXT_POSITIVE_SCALE,
	streetContextRequirementFor,
	ZEROED_MORPHOLOGY_OPTS,
	isBareLocalityTree,
	isBarePostcodeTree,
	runPipeline,
} from "#pipeline/runtime-pipeline"

export { EMPTY_SPAN_PROPOSER_LEXICON, proposeSpans } from "#pipeline/span-proposer"
export type { ProposedSpan, ProposedSpanKind, SpanProposerLexicon } from "#pipeline/span-proposer"
export { deriveInputMode, PipelineFaultStage, QueryIntentCode, WORD_CONSISTENCY_SHIP_DEFAULT } from "#pipeline/types"

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
} from "#pipeline/types"
