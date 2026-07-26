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
	/** Degenerate-surface curation policy applied at build time (absent = uncurated build). */
	exclusionPolicy?: string
	/** Name insertions refused by the curation policy. */
	excludedInsertions?: number
}

export interface BuildFSTOpts {
	dbPath: string
	countries?: string[]
	placetypes?: PlacetypeID[]
	languages?: string[]
	/**
	 * Degenerate-surface curation (build-time; the ASR-contextual-biasing "prune the bias list" discipline). A name whose
	 * FULL normalized token sequence joins to a member of this set is never inserted — the surface carries no
	 * discriminative value as a bias key (bare function words: "la"; bare street-type words: "boulevard"). The FST is a
	 * bias list, not the gazetteer of record — the resolver's candidate tables are untouched, so excluded places stay
	 * findable; they just stop nudging the decoder on degenerate keys. Keys must be `normalizeTokens(...).join(" ")`.
	 */
	excludeSurfaces?: ReadonlySet<string>
	/**
	 * Compositional clause of the same policy: refuse a name whose EVERY normalized token is a member (e.g. "de la") — a
	 * surface made entirely of function words cannot be discriminative. Source this from stopwords only, never
	 * street-type words ("Avenue Road" is a real name; "de la" is not).
	 */
	excludeAllTokensOf?: ReadonlySet<string>
	/** Recorded verbatim into provenance when either exclusion set is supplied. */
	exclusionPolicy?: string
	onProgress?: (phase: string, detail?: string) => void
}

export interface BuildFSTResult {
	stateCount: number
	placeCount: number
	edgeCount: number
	tokenCount: number
}
