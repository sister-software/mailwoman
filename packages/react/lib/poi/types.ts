/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Types for the POI explorer. Live poi.db search is injected as {@link POILiveSearch} so the httpvfs
 *   worker stays out of this package's browser graph.
 */

import type { QueryKindResult } from "@mailwoman/core/pipeline"
import type { POIPhraseLookup, createKindClassifier } from "@mailwoman/kind-classifier"
import type { createPOITaxonomyLookup } from "@mailwoman/poi-taxonomy/table"

/**
 * The POI taxonomy lookup that the explorer runtime loads.
 */
export type TaxonomyLookup = ReturnType<typeof createPOITaxonomyLookup>

/**
 * One taxonomy category record.
 */
export type CategoryRecord = NonNullable<ReturnType<TaxonomyLookup["getPOICategory"]>>

/**
 * The lazily loaded POI runtime, which holds the taxonomy lookup, the lexicon and the kind classifier.
 */
export interface POIRuntime {
	lookup: TaxonomyLookup
	lexicon: POIPhraseLookup
	classify: ReturnType<typeof createKindClassifier>
}

/**
 * Fields shared by every resolved POI subject, category or brand.
 */
export interface POISubjectBase {
	matchedPhrase: string
	confidence: number
	/**
	 * The rest of the query after the subject, usually the location anchor such as "near Springfield".
	 */
	remainder: string
}

/**
 * A resolved POI subject that matched a taxonomy category such as `cafe` or `hospital`.
 */
export interface POICategorySubject extends POISubjectBase {
	kind: "category"
	category: CategoryRecord
	/**
	 * Whether this category requires the locally built OSM (ODbL) layer.
	 */
	buildLocal: boolean
}

/**
 * A resolved POI subject that matched a chain brand such as `chevron`.
 *
 * Live search looks up a brand by its Wikidata QID instead of by category k-ring.
 */
export interface POIBrandSubject extends POISubjectBase {
	kind: "brand"
	/**
	 * The brand's canonical display name.
	 */
	name: string
	/**
	 * The brand's Wikidata QID.
	 * It is absent when the lexicon had no QID for the brand.
	 */
	wikidata?: string
}

/**
 * A resolved POI subject, either a taxonomy category or a chain brand.
 */
export type POISubject = POICategorySubject | POIBrandSubject

/**
 * The intent-only result.
 *
 * It holds the kind verdict and, when a category subject was detected, its OverpassQL export.
 */
export interface POIExplorerResult {
	kindResult: QueryKindResult
	subject?: POISubject
	overpassQL?: string
	overpassError?: string
}

/**
 * One live poi.db hit, as the results list renders it.
 */
export interface POISearchHit {
	name: string
	lat: number
	lon: number
	distanceM: number
	country: string
	confidence: number
}

/**
 * The result of an injected live search.
 *
 * The `unplaced` and `unavailable` states stay separate so the UI can tell an
 * unresolved anchor apart from an unreachable layer.
 */
export type POILiveSearchResult =
	| { status: "success"; hits: POISearchHit[]; centerName: string }
	| { status: "unplaced"; anchor: string }
	| { status: "unavailable" }

/**
 * The injected live-search function.
 *
 * It probes the published poi.db for the resolved category, its Overture leaf
 * categories and the anchor text.
 * The explorer runs intent-only when this function is absent.
 *
 * For a brand subject, `brandWikidata` carries the QID and the probe fetches by it.
 * In that case `categoryID` holds the brand name and `overtureCategoryIDs` is empty.
 *
 * A probe that cannot serve brands should leave `usePOISearch`'s `brandLiveSearch` option unset.
 */
export type POILiveSearch = (params: {
	categoryID: string
	overtureCategoryIDs: string[]
	anchor: string
	/**
	 * The brand's Wikidata QID.
	 * It is present only when the subject is a chain brand.
	 */
	brandWikidata?: string
}) => Promise<POILiveSearchResult>

/**
 * The state of a "Search live" request.
 */
export type LiveSearchState =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "success"; hits: POISearchHit[]; centerName: string }

/**
 * A runtime loader.
 * Stories and tests inject one to substitute a mock taxonomy.
 */
export type LoadPOIRuntime = () => Promise<POIRuntime>
