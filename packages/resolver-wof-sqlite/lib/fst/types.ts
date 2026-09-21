/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Types for the FST gazetteer language model. The FST maps token sequences (place names) to
 *   (placetype, wof_id, parent_chain) entries — pre-computing the valid interpretations for each
 *   prefix of every place name in the gazetteer.
 */

import type { PathBuilderLike } from "path-ts"

export interface PlaceEntry {
	wofID: number
	placetype: PlacetypeID
	name: string
	parentChain: number[]
	/**
	 * Population-based referential likelihood in [0, 1], used by decoder bias.
	 */
	referential: number
	/**
	 * Encyclopedic importance in [0, 1] for display only; `undefined` means unavailable.
	 */
	encyclopedic?: number
	lat: number
	lon: number
	/**
	 * Number of countries sharing this accepting surface, clamped to 255; `undefined` means unavailable.
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
	/**
	 * How many places carried a non-zero referential score at build time.
	 * Named `importanceMatches` for stamp compatibility with every artifact written before
	 * the two-score split — renaming the JSON key would make every existing stamp unreadable,
	 * and the number means the same thing it always did on a population-built artifact.
	 */
	importanceMatches: number
	/**
	 * How many places carried an encyclopedic score at build time.
	 * `undefined` on a pre-split build — which is not the same as 0 (a v5 build against a
	 * population-only database), so the freshness report says the two in different words.
	 */
	encyclopedicMatches?: number
	/**
	 * How the builder obtained its two scores — an {@link ImportanceSplitSource}.
	 * Recorded so an artifact states, in its own provenance, whether its encyclopedic
	 * channel is real, reconstructed from a legacy conflated column, or absent.
	 */
	importanceSource?: string
	sourceDB?: string
	/**
	 * MD5 of the source database's bytes at build time — the artifact's link to
	 * the gazetteer it is a projection of.
	 *
	 * `sourceDB` records the path, which is exactly the field that cannot change when the bytes
	 * behind it do: the admin DB is a sealed readonly artifact that a rebuild replaces in place.
	 * Therefore, every FST built before the 2026-08-04 swap still names the current file
	 * and none of them was built from it. Compared by `fst-freshness.ts`.
	 *
	 * `undefined` = built before the stamp existed (every artifact predating 2026-08-05).
	 * Never conflate that with "built from a database whose md5 is unknown" —
	 * the freshness check reports the two in different words.
	 */
	sourceDBMD5?: string
	/**
	 * Byte size of the source database at build time. Not redundant with {@link FSTProvenance.sourceDBMD5}:
	 * it survives a truncated source and it is what makes a staleness warning legible —
	 * "5,273,722,880 → 5,372,076,032" names the rebuild, a hex delta does not.
	 */
	sourceDBBytes?: number
	modelCardVersion?: string
	/**
	 * Degenerate-surface curation policy applied at build time (absent = uncurated build).
	 */
	exclusionPolicy?: string
	/**
	 * Name insertions refused by the curation policy.
	 */
	excludedInsertions?: number
}

export interface BuildFSTOpts {
	dbPath: PathBuilderLike
	/**
	 * Pre-computed identity of `dbPath` to stamp into provenance.
	 * Omit and the builder reads it via `readWOFSourceIdentity` (sidecar-cached).
	 * Supply it when the digest is already in hand, or when the caller is building
	 * from something whose identity it defines itself.
	 */
	sourceIdentity?: { md5: string; bytes: number }
	countries?: string[]
	placetypes?: PlacetypeID[]
	languages?: string[]
	/**
	 * Degenerate-surface curation (build-time. the ASR-contextual-biasing "prune the bias list" discipline). A name whose
	 * full normalized token sequence joins to a member of this set is never inserted — the surface carries no
	 * discriminative value as a bias key (bare function words: "la"; bare street-type words: "boulevard"). The FST is a
	 * bias list rather than the gazetteer of record — the resolver's candidate tables are untouched, so excluded places
	 * stay findable. they just stop nudging the decoder on degenerate keys. Keys must be `normalizeTokens(...).join("
	 * ")`.
	 */
	excludeSurfaces?: ReadonlySet<string>
	/**
	 * Compositional clause of the same policy: refuse a name whose every normalized
	 * token is a member (e.g. "de la") — a surface made entirely of function words
	 * cannot be discriminative. Source this from stopwords only, never street-type
	 * words ("Avenue Road" is a real name; "de la" is not).
	 */
	excludeAllTokensOf?: ReadonlySet<string>
	/**
	 * Recorded verbatim into provenance when either exclusion set is supplied.
	 */
	exclusionPolicy?: string
	/**
	 * Surface-ambiguity classes (survey #4, 2026-07-27): normalized-join surface → the number of
	 * distinct countries (across the whole admin DB rather than just this build's country scope)
	 * with a place carrying that surface. When supplied, every inserted place row
	 * records the count for its accepting surface (`PlaceEntry.crossCountryBranches`) —
	 * an entry accessible under several surfaces records each surface's own count.
	 * Serialized into the place row's former `_pad` byte with presence signaled by header
	 * flags bit0, so version stays put and pre-ambiguity artifacts read as "no data"
	 * (never "0 branches" — the meaning-of-zero rule). No decoder consumes it yet. consumers
	 * (FST-prior tempering, the Option-A evidence channel) arrive behind their own measured checks.
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
