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
	/**
	 * Surface-ambiguity class (survey #4): how many DISTINCT countries carry a place with THIS entry's accepting surface,
	 * counted over the whole admin DB at build time (clamped to 255). A property of the surface, not the place — the same
	 * place reached via different alias surfaces reports each surface's own count. `undefined` = built without ambiguity
	 * data (pre-2026-07-27 artifacts) — NEVER conflate with 1 (the unambiguous case); the meaning-of-zero rule.
	 */
	crossCountryBranches?: number
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
	/**
	 * Surface-ambiguity classes (survey #4, 2026-07-27): normalized-join surface → the number of DISTINCT countries
	 * (across the WHOLE admin DB, not just this build's country scope) with a place carrying that surface. When supplied,
	 * every inserted place row records the count for ITS accepting surface (`PlaceEntry.crossCountryBranches`) — an entry
	 * accessible under several surfaces records each surface's own count. Serialized into the place row's former `_pad`
	 * byte with presence signaled by header flags bit0, so VERSION stays put and pre-ambiguity artifacts read as "no
	 * data" (never "0 branches" — the meaning-of-zero rule). No decoder consumes it yet; consumers (FST-prior tempering,
	 * the Option-A evidence channel) arrive behind their own measured gates.
	 */
	surfaceCountryCounts?: ReadonlyMap<string, number>
	onProgress?: (phase: string, detail?: string) => void
}

export interface BuildFSTResult {
	stateCount: number
	placeCount: number
	edgeCount: number
	tokenCount: number
}
