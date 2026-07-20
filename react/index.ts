/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/react` — React components + headless hooks for mailwoman.
 *
 *   Two composed explorers plus the small presentational units and headless hooks they decompose into:
 *
 *   - `POIExplorer` — a self-contained POI-intent tester (classify → subject → OverpassQL), with an
 *     optional injected live poi.db search. No weights, no network on the intent path.
 *   - `PipelineExplorer` — a parse+resolve tester driven by an INJECTED `PipelineRuntime`, so the
 *     model/gazetteer plumbing (ONNX, httpvfs, node builtins) stays in the host, never in this graph.
 *
 *   Styling ships separately as `@mailwoman/react/styles.css` (plain, `mw-`-prefixed, Infima-token
 *   aware) — no CSS is imported by the component modules, so the bare package import is node-safe.
 */

// ── Common primitives ──────────────────────────────────────────────────────
export { ClientOnly } from "./common/ClientOnly.tsx"
export type { ClientOnlyProps } from "./common/ClientOnly.tsx"
export { CopyButton } from "./common/CopyButton.tsx"
export type { CopyButtonProps } from "./common/CopyButton.tsx"
export { cx } from "./common/cx.ts"
export type { ClassValue } from "./common/cx.ts"
export { KindBadge } from "./common/KindBadge.tsx"
export type { KindBadgeProps, KindBadgeResult } from "./common/KindBadge.tsx"
export { LoadingIndicator } from "./common/LoadingIndicator.tsx"
export type { LoadingIndicatorProps, LoadingMode } from "./common/LoadingIndicator.tsx"
export { PresetChips } from "./common/PresetChips.tsx"
export type { Preset, PresetChipsProps } from "./common/PresetChips.tsx"
export { useClipboard } from "./common/useClipboard.ts"
export type { UseClipboard } from "./common/useClipboard.ts"
export { useDebouncedValue } from "./common/useDebouncedValue.ts"

// ── POI explorer ───────────────────────────────────────────────────────────
export { AbstainPanel } from "./poi/AbstainPanel.tsx"
export type { AbstainPanelProps } from "./poi/AbstainPanel.tsx"
export { LiveResultsBlock } from "./poi/LiveResultsBlock.tsx"
export type { LiveResultsBlockProps } from "./poi/LiveResultsBlock.tsx"
export { OverpassBlock } from "./poi/OverpassBlock.tsx"
export type { OverpassBlockProps } from "./poi/OverpassBlock.tsx"
export { POIExplorer } from "./poi/POIExplorer.tsx"
export type { POIExplorerProps } from "./poi/POIExplorer.tsx"
export { QueryInput } from "./poi/QueryInput.tsx"
export type { QueryInputProps } from "./poi/QueryInput.tsx"
export { formatDistance, loadPOIRuntime, POI_DEFAULT_TEXT, POI_PRESETS } from "./poi/runtime.ts"
export { SubjectPanel } from "./poi/SubjectPanel.tsx"
export type { SubjectPanelProps } from "./poi/SubjectPanel.tsx"
export type {
	CategoryRecord,
	LiveSearchState,
	LoadPOIRuntime,
	POIBrandSubject,
	POICategorySubject,
	POIExplorerResult,
	POILiveSearch,
	POILiveSearchResult,
	POIRuntime,
	POISearchHit,
	POISubject,
	POISubjectBase,
	TaxonomyLookup,
} from "./poi/types.ts"
export { usePOISearch } from "./poi/usePOISearch.ts"
export type { UsePOISearch, UsePOISearchOptions } from "./poi/usePOISearch.ts"

// ── Pipeline explorer ──────────────────────────────────────────────────────
export { CandidatePicker } from "./pipeline/CandidatePicker.tsx"
export type { CandidatePickerProps } from "./pipeline/CandidatePicker.tsx"
export { ComponentTable } from "./pipeline/ComponentTable.tsx"
export type { ComponentTableProps } from "./pipeline/ComponentTable.tsx"
export { ConfidenceCell } from "./pipeline/ConfidenceCell.tsx"
export type { ConfidenceCellProps } from "./pipeline/ConfidenceCell.tsx"
export { buildParsePayload } from "./pipeline/copy.ts"
export { PIPELINE_DEFAULT_ADDRESS, PIPELINE_PRESETS } from "./pipeline/presets.ts"
export { PipelineExplorer } from "./pipeline/PipelineExplorer.tsx"
export type { PipelineExplorerProps } from "./pipeline/PipelineExplorer.tsx"
export { QueryForm } from "./pipeline/QueryForm.tsx"
export type { QueryFormProps } from "./pipeline/QueryForm.tsx"
export { ResolvedPlace } from "./pipeline/ResolvedPlace.tsx"
export type { ResolvedPlaceProps } from "./pipeline/ResolvedPlace.tsx"
export type {
	DualRoleView,
	FSTProvenance,
	ParsedComponent,
	ParseResult,
	PipelineLoadingState,
	PipelinePanels,
	PipelineRuntime,
	ResolvedPlaceView,
	StageTiming,
} from "./pipeline/types.ts"
export { useParsePipeline } from "./pipeline/useParsePipeline.ts"
export type { UseParsePipeline, UseParsePipelineOptions } from "./pipeline/useParsePipeline.ts"
