/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Types for the FST gazetteer. These types map place-name token sequences to place entries.
 */

import type { PathBuilderLike } from "path-ts"

/**
 * One place that a token sequence in the FST accepts.
 */
export interface PlaceEntry {
	wofID: number
	placetype: PlacetypeID
	name: string
	parentChain: number[]
	/**
	 * The population-based referential likelihood in [0, 1] that the decoder bias uses.
	 */
	referential: number
	/**
	 * The encyclopedic importance in [0, 1], for display only.
	 * It is `null` when unavailable.
	 */
	encyclopedic: number | null
	lat: number
	lon: number
	/**
	 * The number of countries with a place of this surface, clamped to 255.
	 * It is `null` when unavailable.
	 */
	crossCountryBranches: number | null
}

/**
 * The placetypes the FST stores.
 */
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

/**
 * One outgoing edge from an FST state, with the number of places its target state accepts.
 */
export interface FSTContinuation {
	token: string
	targetState: number
	acceptingCount: number
}

/**
 * The places a token path accepts and the tokens that can extend it.
 */
export interface FSTQueryResult {
	path: string[]
	stateID: number
	accepting: PlaceEntry[]
	continuations: FSTContinuation[]
}

/**
 * The build metadata stored in an FST binary's provenance trailer.
 */
export interface FSTProvenance {
	builtAt: string
	countries: string[]
	stateCount: number
	placeCount: number
	edgeCount: number
	nameInsertions: number
	/**
	 * The count of places with a non-zero referential score at build time.
	 *
	 * The key keeps its older name so that existing provenance stamps stay readable.
	 */
	importanceMatches: number
	/**
	 * The count of places with an encyclopedic score at build time.
	 *
	 * It is `null` for a build that predates the separate encyclopedic score.
	 * The value `0` means a current build used a database without encyclopedic scores.
	 */
	encyclopedicMatches: number | null
	/**
	 * The {@link ImportanceSplitSource} that records whether the encyclopedic score is real,
	 * reconstructed from a legacy column, or absent.
	 */
	importanceSource: string | null
	sourceDB: string | null
	/**
	 * The MD5 of the source database's bytes at build time.
	 * The freshness check compares it.
	 *
	 * `sourceDB` by itself cannot detect staleness.
	 * A rebuild replaces the admin database at the same path.
	 *
	 * The field is `null` for artifacts built before the stamp existed.
	 * An unknown digest has a different value.
	 */
	sourceDBMD5: string | null
	/**
	 * The byte size of the source database at build time.
	 *
	 * It detects a truncated source and makes a staleness warning readable.
	 */
	sourceDBBytes: number | null
	modelCardVersion: string | null
	/**
	 * The surface-exclusion policy applied at build time.
	 * It is absent for an uncurated build.
	 */
	exclusionPolicy: string | null
	/**
	 * The count of name insertions the exclusion policy rejected.
	 */
	excludedInsertions: number | null
}

/**
 * Options for building an FST from a WOF admin database.
 */
export interface BuildFSTOpts {
	dbPath: PathBuilderLike
	/**
	 * The precomputed identity of `dbPath` to record in provenance.
	 *
	 * When omitted, the builder reads it with `readWOFSourceIdentity`, which caches it in a sidecar file.
	 */
	sourceIdentity?: { md5: string; bytes: number }
	countries?: string[]
	placetypes?: PlacetypeID[]
	languages?: string[]
	/**
	 * Surfaces the builder never inserts, such as the bare function word "la"
	 * or the bare street type "boulevard".
	 *
	 * These surfaces do not discriminate between places when used as decoder bias keys.
	 * The resolver's candidate tables still hold the excluded places.
	 * Keys must be `normalizeTokens(...).join(" ")`.
	 */
	excludeSurfaces?: ReadonlySet<string>
	/**
	 * Tokens that a name must not consist of entirely, such as "de la".
	 *
	 * Build this set from stopwords only.
	 * A street-type word can be part of a real name, as in "Avenue Road".
	 */
	excludeAllTokensOf?: ReadonlySet<string>
	/**
	 * The policy label recorded in provenance when either exclusion set is supplied.
	 */
	exclusionPolicy?: string
	/**
	 * Maps each normalized surface to the number of distinct countries in the whole
	 * admin database with a place of that surface.
	 *
	 * When supplied, each inserted place entry records the count for its accepting
	 * surface as `PlaceEntry.crossCountryBranches`.
	 * A place reachable under several surfaces records each surface's own count.
	 */
	surfaceCountryCounts?: ReadonlyMap<string, number>
	onProgress?: (phase: string, detail?: string) => void
}

/**
 * Counts reported by an FST build.
 */
export interface BuildFSTResult {
	stateCount: number
	placeCount: number
	edgeCount: number
	tokenCount: number
}
