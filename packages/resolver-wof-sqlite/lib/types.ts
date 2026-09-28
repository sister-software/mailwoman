/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { LatLon, LatLonBounds } from "@mailwoman/spatial"

/**
 * Lists the Who's On First placetypes this resolver looks up, ordered roughly from coarsest to finest.
 */
export type WOFPlacetype =
	| "country"
	| "macroregion"
	| "region"
	| "macrocounty"
	| "county"
	| "localadmin"
	| "locality"
	| "borough"
	| "neighbourhood"
	| "microhood"
	| "postalcode"
	| "venue"
	| "campus"
	| "address"

/**
 * Describes one ranked match for a place lookup, with `id` as the WOF id so the shape satisfies `ResolvedPlace`.
 */
export interface PlaceCandidate {
	id: number
	name: string
	placetype: WOFPlacetype

	/**
	 * The ISO 3166-1 alpha-2 country code.
	 */
	country: string
	lat: number
	lon: number

	/**
	 * The place's depth-1 ancestor id from the ancestors sidecar, absent when the artifact has no sidecar even for a place with a parent.
	 */
	parent_id?: number
	score: number
	distanceKm?: number

	/**
	 * Whether the candidate's name or an alias exactly equals the query, used by a later re-rank to stay within the exact-match tier.
	 */
	exactMatch?: boolean

	/**
	 * The population term plus the best proximity-bias term, which the exact tier sorts by instead of population when the query has `near` or `bias`.
	 */
	prominence?: number

	/**
	 * The WOF `wof:population` value, absent when the population is unknown.
	 */
	population?: number

	/**
	 * The referential likelihood in [0, 1], derived from {@link PlaceCandidate.population} and absent whenever it is.
	 */
	referential?: number

	/**
	 * The encyclopedia-evidence importance in [0, 1], used for display only and present only when the extract's `place_importance` table has the split columns.
	 */
	encyclopedic?: number

	/**
	 * The blended toponym prior in [0, 1] that `rankByImportance` reads for bare toponyms, set only by the candidate-table backend.
	 */
	importance?: number

	/**
	 * The bounding box from the WOF `spr` extent columns, omitted when the schema lacks them.
	 */
	bbox?: LatLonBounds

	/**
	 * Set by the postcode path when the chosen locality is far from the postcode's own locality; the candidate is still returned so callers can lower their confidence.
	 */
	mismatch?: boolean

	/**
	 * Whether the ancestors sidecar places this candidate under the query's {@link FindPlaceQuery.regionQualifier}, with `false` meaning the check ran and an absent value meaning it did not.
	 */
	containedByQualifier?: boolean

	/**
	 * Set when the variant exemption spared the candidate from the cross-country alias penalty, by the candidate-table backend only.
	 */
	variantAliasExempted?: true
}

/**
 * Describes a place lookup where every field except `text` narrows or ranks the search, and an extract without the R*Tree index silently ignores `bbox` and `near.maxDistanceKm`.
 */
export interface FindPlaceQuery {
	text: string
	placetype?: WOFPlacetype | WOFPlacetype[]

	/**
	 * Restricts matches to one ISO 3166-1 alpha-2 country.
	 */
	country?: string

	/**
	 * Restricts the typo-fuzzy tier to one ISO 3166-1 alpha-2 country, returning no result on a miss rather than falling back worldwide; ignored when `country` is set.
	 */
	fuzzyCountry?: string

	/**
	 * Whether to match only primary names, set by probes that re-read a token from a longer span because that token was never an alias.
	 */
	primaryOnly?: boolean

	/**
	 * Alias name roles, such as `abbr` or `gloss`, that the probe excludes; rows with no role and artifacts without a role column are unaffected.
	 */
	excludeNameRoles?: readonly string[]

	/**
	 * Restricts matches to descendants of this WOF place id.
	 */
	parentID?: number

	/**
	 * The sibling postcode for a `locality` query; a `postcode_locality` table adds that postcode's localities and scores them on a weighted blend so small localities a name match misses are found.
	 */
	postcode?: string

	/**
	 * Whether a locality query with `postcode` moves candidates near the postcode's centroid to the front, sorted by distance, with the rest keeping their order.
	 */
	postcodeContainmentCoherence?: boolean

	/**
	 * The parsed region qualifier for a locality lookup; a backend with the ancestors sidecar marks contained candidates, ranks them first, may add ones a country scope hid, and never removes candidates.
	 */
	regionQualifier?: string

	/**
	 * A proximity hint that boosts nearby candidates and filters by radius only when `maxDistanceKm` is set.
	 */
	near?: LatLon & { maxDistanceKm?: number }

	/**
	 * Ordered proximity-bias points with an optional weight defaulting to 1; the bias re-ranks exact-tier candidates by combined prominence, never removes them, and counts `near` as weight 1.
	 */
	bias?: Array<LatLon & { weight?: number }>

	/**
	 * Returns only candidates whose bounding box intersects this box.
	 */
	bbox?: LatLonBounds

	/**
	 * The maximum number of candidates to return, defaulting to 10.
	 */
	limit?: number
}

/**
 * Resolves a {@link FindPlaceQuery} to ranked {@link PlaceCandidate}s, asynchronously so a worker-backed implementation can share the interface.
 */
export interface PlaceLookup extends Disposable {
	findPlace(query: FindPlaceQuery): Promise<PlaceCandidate[]>
}
