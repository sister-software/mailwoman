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
 * Describes one ranked match for a place lookup, with `id` as the WOF id
 * so the shape satisfies `ResolvedPlace`.
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
	 * The place's depth-1 ancestor id from the ancestors sidecar, absent when the
	 * artifact has no sidecar even for a place with a parent.
	 */
	parent_id: number | null
	score: number
	distanceKm: number | null

	/**
	 * Whether the candidate's name or an alias exactly equals the query, used by a
	 * later re-rank to stay within the exact-match tier.
	 */
	exactMatch: boolean | null

	/**
	 * The population term plus the best proximity-bias term.
	 *
	 * The exact tier sorts by this value instead of population when the query has `near` or `bias`.
	 */
	prominence: number | null

	/**
	 * The WOF `wof:population` value, absent when the population is unknown.
	 */
	population: number | null

	/**
	 * The referential likelihood in [0, 1], derived from {@link PlaceCandidate.population}
	 * and absent whenever it is.
	 */
	referential: number | null

	/**
	 * The encyclopedia-evidence importance in [0, 1], used for display only and present only
	 * when the extract's `place_importance` table has the split columns.
	 */
	encyclopedic: number | null

	/**
	 * The blended toponym prior in [0, 1] that `rankByImportance` reads for bare toponyms,
	 * set only by the candidate-table backend.
	 */
	importance: number | null

	/**
	 * The bounding box from the WOF `spr` extent columns, omitted when the schema lacks them.
	 */
	bbox: LatLonBounds | null

	/**
	 * Set by the postcode path when the chosen locality is far from the postcode's own
	 * locality. the candidate is still returned so callers can lower their confidence.
	 */
	mismatch: boolean | null

	/**
	 * Whether the ancestors sidecar places this candidate under the query's
	 * {@link FindPlaceQuery.regionQualifier}, with `false` meaning the check ran
	 * and an absent value meaning it did not.
	 */
	containedByQualifier: boolean | null

	/**
	 * Set when the candidate lies outside the query's parent scope, so callers can demote it.
	 */
	regionScopeMiss: boolean | null

	/**
	 * Set when the variant exemption spared the candidate from the cross-country
	 * alias penalty, by the candidate-table backend only.
	 */
	variantAliasExempted: true | null
}

/**
 * Describes a place lookup.
 *
 * Every field except `text` narrows or ranks the search.
 * An extract without the R*Tree index ignores `bbox` and `near.maxDistanceKm` without an error.
 */
export interface FindPlaceQuery {
	text: string
	placetype?: WOFPlacetype | WOFPlacetype[]

	/**
	 * Restricts matches to one ISO 3166-1 alpha-2 country.
	 */
	country?: string

	/**
	 * Restricts the typo-fuzzy tier to one ISO 3166-1 alpha-2 country, returning no
	 * result on a miss rather than falling back worldwide.
	 * Ignored when `country` is set.
	 */
	fuzzyCountry?: string

	/**
	 * Whether to match only primary names, set by probes that re-read a token from
	 * a longer span because that token was never an alias.
	 */
	primaryOnly?: boolean

	/**
	 * Alias name roles, such as `abbr` or `gloss`, that the probe excludes.
	 *
	 * Rows with no role and artifacts without a role column are unaffected.
	 */
	excludeNameRoles?: readonly string[]

	/**
	 * Restricts matches to descendants of this WOF place id.
	 */
	parentID?: number

	/**
	 * The sibling postcode for a `locality` query.
	 *
	 * A `postcode_locality` table adds that postcode's localities and scores them on a
	 * weighted blend so small localities a name match misses are found.
	 */
	postcode?: string

	/**
	 * Whether a locality query with `postcode` moves candidates near the postcode's centroid
	 * to the front, sorted by distance, with the rest keeping their order.
	 */
	postcodeContainmentCoherence?: boolean

	/**
	 * The parsed region qualifier for a locality lookup.
	 *
	 * A backend with the ancestors sidecar marks contained candidates.
	 * It ranks them first.
	 *
	 * It may add candidates hidden by a country scope.
	 * It never removes candidates.
	 */
	regionQualifier?: string

	/**
	 * A proximity hint that boosts nearby candidates and filters by radius only when `maxDistanceKm` is set.
	 */
	near?: LatLon & { maxDistanceKm?: number }

	/**
	 * Ordered proximity-bias points with an optional weight defaulting to 1.
	 *
	 * The bias re-ranks exact-tier candidates by combined prominence.
	 * It keeps every candidate.
	 * It counts `near` as weight 1.
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
 * Resolves a {@link FindPlaceQuery} to ranked {@link PlaceCandidate}s, asynchronously
 * so a worker-backed implementation can share the interface.
 */
export interface PlaceLookup extends Disposable {
	findPlace(query: FindPlaceQuery): Promise<PlaceCandidate[]>
}
