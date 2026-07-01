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
	placetype: PlacetypeID
	name: string
	parentChain: number[]
	importance: number
	lat: number
	lon: number
}

export type PlacetypeID =
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

export interface FSTMatchResult {
	stateID: number
	accepted: boolean
	depth: number
}

export interface FSTContinuation {
	token: string
	targetState: number
	acceptingCount: number
}

export interface FSTQueryResult {
	path: string[]
	stateID: number
	accepting: PlaceEntry[]
	continuations: FSTContinuation[]
}

export interface FSTProvenance {
	builtAt: string
	countries: string[]
	stateCount: number
	placeCount: number
	edgeCount: number
	nameInsertions: number
	importanceMatches: number
	sourceDB?: string
	modelCardVersion?: string
}

export interface BuildFSTOpts {
	dbPath: string
	countries?: string[]
	placetypes?: PlacetypeID[]
	languages?: string[]
	onProgress?: (phase: string, detail?: string) => void
}

export interface BuildFSTResult {
	stateCount: number
	placeCount: number
	edgeCount: number
	tokenCount: number
}
