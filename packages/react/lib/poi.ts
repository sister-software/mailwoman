/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file POI explorer components, hooks, runtime and interfaces.
 */

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
export { formatDistance, loadPOIRuntime, POI_DEFAULT_TEXT, POI_PRESETS } from "#poi/runtime"
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
	POILiveSearchRequest,
	POILiveSearchResult,
	POIRuntime,
	POISearchHit,
	POISubject,
	POISubjectBase,
	TaxonomyLookup,
} from "#poi/types"

export { usePOISearch } from "#poi/usePOISearch"
export type { UsePOISearch, UsePOISearchOptions } from "#poi/usePOISearch"
