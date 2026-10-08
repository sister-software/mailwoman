/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Runtime pipeline coordinator — see `stages.md` for the full interface.
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

export {
	CASE_NORMALIZATIONS,
	caseNormalizationOf,
	DEFAULT_CASE_NORMALIZATION,
	DEFAULT_PLACER_COUNTRY_USE,
	deriveInputMode,
	InputModeSchema,
	InputModeSelectionSchema,
	PipelineFaultStage,
	POIIntentSchema,
	POIQueryResultSchema,
	POIResultSchema,
	POISpatialRelationSchema,
	QueryIntentCode,
	QueryIntentCodeSchema,
	QueryIntentMarkerSchema,
	QueryKindSchema,
	WORD_CONSISTENCY_SHIP_DEFAULT,
} from "#pipeline/types"

export type {
	AddressClassifier,
	CaseNormalization,
	ClassifierOpts,
	FSTMatcherLike,
	InputMode,
	InputModeSelection,
	LocaleDetector,
	LocaleHint,
	PhraseGrouper,
	PhraseKind,
	PhraseProposal,
	PipelineOpts,
	PipelineTiming,
	PlacetypePairSelection,
	PlacerCountryUse,
	POIIntent,
	POIQueryResult,
	POIResult,
	POISpatialRelation,
	QueryIntentMarker,
	QueryKind,
	QueryKindResult,
	QueryShapeLite,
	RuntimePipelineStages,
	StageSource,
	UserLocation,
	WordConsistencyOpts,
	WordConsistencySetting,
} from "#pipeline/types"

export type { MachinePreferences } from "#pipeline/preferences"
export type { PipelineFault, PipelineResult } from "#pipeline/result"
