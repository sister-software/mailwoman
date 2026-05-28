/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Types for the FST gazetteer language model. The FST maps token sequences (place names) to
 *   (placetype, wof_id, parent_chain) entries — pre-computing the valid interpretations for each
 *   prefix of every place name in the gazetteer.
 */

export interface PlaceEntry {
	wofID: number
	placetype: PlacetypeId
	name: string
	parentChain: number[]
	importance: number
	lat: number
	lon: number
}

export type PlacetypeId =
	| "country"
	| "region"
	| "county"
	| "locality"
	| "localadmin"
	| "borough"
	| "neighbourhood"
	| "postalcode"
	| "campus"
	| "dependency"
	| "street_affix"

export interface FstMatchResult {
	stateId: number
	accepted: boolean
	depth: number
}

export interface FstContinuation {
	token: string
	targetState: number
	acceptingCount: number
}

export interface FstQueryResult {
	path: string[]
	stateId: number
	accepting: PlaceEntry[]
	continuations: FstContinuation[]
}

export interface FstProvenance {
	builtAt: string
	countries: string[]
	stateCount: number
	placeCount: number
	edgeCount: number
	nameInsertions: number
	importanceMatches: number
	sourceDb?: string
	modelCardVersion?: string
}

export interface BuildFstOpts {
	dbPath: string
	countries?: string[]
	placetypes?: PlacetypeId[]
	languages?: string[]
	onProgress?: (phase: string, detail?: string) => void
}

export interface BuildFstResult {
	stateCount: number
	placeCount: number
	edgeCount: number
	tokenCount: number
}
