/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Types for the POI explorer. The intent path (classification → subject → OverpassQL) is fully
 *   self-contained over the pure `@mailwoman/*` packages; the live poi.db path is expressed only as an
 *   INJECTED async function ({@link POILiveSearch}) so the httpvfs/worker machinery stays out of this
 *   package's browser graph (it lives in the docs site, which knows where the layer is served).
 */

import type { POIPhraseLookup, QueryKindResult } from "@mailwoman/kind-classifier"
import type { createKindClassifier } from "@mailwoman/kind-classifier"
import type { createPOITaxonomyLookup } from "@mailwoman/poi-taxonomy/table"

export type TaxonomyLookup = ReturnType<typeof createPOITaxonomyLookup>
export type CategoryRecord = NonNullable<ReturnType<TaxonomyLookup["getPOICategory"]>>

/** The lazily-loaded POI runtime: the taxonomy lookup, the adapted lexicon, and the kind classifier over it. */
export interface POIRuntime {
	lookup: TaxonomyLookup
	lexicon: POIPhraseLookup
	classify: ReturnType<typeof createKindClassifier>
}

/** A resolved POI subject — the category the query names plus its match metadata. */
export interface POISubject {
	category: CategoryRecord
	matchedPhrase: string
	confidence: number
	/** The non-subject remainder of the query (the location anchor, e.g. "near Springfield"). */
	remainder: string
	/** Whether this category needs the locally-built OSM (ODbL) layer — precomputed off the runtime. */
	buildLocal: boolean
}

/** The intent-only result: the kind verdict plus (when a subject was detected) its OverpassQL export. */
export interface POIExplorerResult {
	kindResult: QueryKindResult
	subject?: POISubject
	overpassQL?: string
	overpassError?: string
}

/** One live poi.db hit, as the results list renders it. */
export interface POISearchHit {
	name: string
	lat: number
	lon: number
	distanceM: number
	country: string
	confidence: number
}

/**
 * Result of an injected live search. Preserves the original tester's two failure modes — the anchor not resolving vs
 * the published layer being unreachable — so the UI can word them differently.
 */
export type POILiveSearchResult =
	| { status: "success"; hits: POISearchHit[]; centerName: string }
	| { status: "unplaced"; anchor: string }
	| { status: "unavailable" }

/**
 * The injected live-search function. Given the resolved category (+ its Overture leaf fan-out) and the anchor text, it
 * probes the published poi.db and returns hits. Absent ⇒ the explorer runs intent-only (no "Search live" button).
 */
export type POILiveSearch = (params: {
	categoryID: string
	overtureCategoryIDs: string[]
	anchor: string
}) => Promise<POILiveSearchResult>

/** "Search live" state machine. */
export type LiveSearchState =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "success"; hits: POISearchHit[]; centerName: string }

/** A single-argument runtime loader — injectable so stories/tests can substitute a mock taxonomy. */
export type LoadPOIRuntime = () => Promise<POIRuntime>
