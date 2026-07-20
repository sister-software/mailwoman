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

/** Fields shared by every resolved POI subject, category or brand. */
export interface POISubjectBase {
	matchedPhrase: string
	confidence: number
	/** The non-subject remainder of the query (the location anchor, e.g. "near Springfield"). */
	remainder: string
}

/** A resolved POI subject that names a taxonomy CATEGORY (`cafe`, `hospital`, `drinking fountain`). */
export interface POICategorySubject extends POISubjectBase {
	kind: "category"
	category: CategoryRecord
	/** Whether this category needs the locally-built OSM (ODbL) layer — precomputed off the runtime. */
	buildLocal: boolean
}

/**
 * A resolved POI subject that names a chain BRAND (`chevron`, `applebee's`). Brands carry a Wikidata QID and are
 * searched by that QID, NOT by category k-ring — see `@mailwoman/poi-taxonomy`'s brand table + the layer's
 * `brand_wikidata` index.
 */
export interface POIBrandSubject extends POISubjectBase {
	kind: "brand"
	/** The brand's canonical display name. */
	name: string
	/** Wikidata QID, when the lexicon carried one (`Q319642` = Chevron). Absent ⇒ matched by name alone. */
	wikidata?: string
}

/** A resolved POI subject — a taxonomy category or a chain brand — plus its match metadata. */
export type POISubject = POICategorySubject | POIBrandSubject

/** The intent-only result: the kind verdict plus (when a subject was detected) its OverpassQL export (category only). */
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
 *
 * Brand support is ADDITIVE: when the resolved subject is a chain brand, `brandWikidata` carries its QID and the probe
 * fetches by that QID instead of a category k-ring (`categoryID`/`overtureCategoryIDs` are then the brand name / empty
 * and unused). The category path is byte-identical to before. A probe that can't serve brands simply leaves brand live
 * search unwired at the call site (see `usePOISearch`'s `brandLiveSearch` option) — the docs' httpvfs probe does
 * exactly that, brand-wide row hydration being pathological over byte-range (measured; the brand path is server-side
 * only).
 */
export type POILiveSearch = (params: {
	categoryID: string
	overtureCategoryIDs: string[]
	anchor: string
	/** Present when the subject is a chain brand — the probe fetches by this QID, not a category k-ring. */
	brandWikidata?: string
}) => Promise<POILiveSearchResult>

/** "Search live" state machine. */
export type LiveSearchState =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "success"; hits: POISearchHit[]; centerName: string }

/** A single-argument runtime loader — injectable so stories/tests can substitute a mock taxonomy. */
export type LoadPOIRuntime = () => Promise<POIRuntime>
