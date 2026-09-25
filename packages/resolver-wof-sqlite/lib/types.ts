/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

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
 * Describes one ranked match for a place lookup.
 *
 * The `score` field is only meaningful as an ordering.
 * The `distanceKm` field is set only when the query has `near`.
 *
 * The WOF id is stored as `id` so that this shape satisfies `ResolvedPlace` from `@mailwoman/resolver`.
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
	 * The place's depth-1 ancestor id from the ancestors sidecar.
	 *
	 * The field is absent when the artifact has no sidecar, even for a place with a parent.
	 * A consumer can use it to tell whether a locality and a `localadmin` of the same name are one settlement.
	 */
	parent_id?: number
	score: number
	distanceKm?: number

	/**
	 * Whether the candidate's name or an alias exactly equals the query.
	 *
	 * A later re-rank uses it to stay within the exact-match tier.
	 */
	exactMatch?: boolean

	/**
	 * The population term plus the best proximity-bias term.
	 *
	 * The exact tier sorts by this instead of population when the query has `near` or `bias`.
	 */
	prominence?: number

	/**
	 * The WOF `wof:population` value.
	 * An absent value means the population is unknown.
	 */
	population?: number

	/**
	 * The referential likelihood in [0, 1], derived from {@link PlaceCandidate.population}.
	 *
	 * It orders candidates the same way population does, and it is absent whenever population is.
	 */
	referential?: number

	/**
	 * The encyclopedia-evidence importance in [0, 1], used for display only.
	 *
	 * It is present only when the extract's `place_importance` table has the split columns.
	 * An absent value means the importance is unknown.
	 */
	encyclopedic?: number

	/**
	 * The blended toponym prior in [0, 1] that `rankByImportance` reads for bare toponyms.
	 *
	 * Only the candidate-table backend sets it.
	 * An absent value means the prior is unknown.
	 */
	importance?: number

	/**
	 * The bounding box from the WOF `spr` extent columns, omitted when the schema lacks them.
	 */
	bbox?: GeoBbox

	/**
	 * Set by the postcode path when the chosen locality is far from the postcode's own locality.
	 *
	 * The candidate is still returned so that callers can lower their confidence.
	 */
	mismatch?: boolean

	/**
	 * Whether the ancestors sidecar places this candidate under the
	 * query's {@link FindPlaceQuery.regionQualifier}.
	 *
	 * The value `false` means the check ran and the candidate is outside the region.
	 * An absent value means the check did not run.
	 */
	containedByQualifier?: boolean

	/**
	 * Set when the variant exemption spared the candidate from the cross-country alias penalty.
	 *
	 * Only the candidate-table backend sets it.
	 */
	variantAliasExempted?: true
}

/**
 * Represents a WGS-84 point, used as a proximity hint by {@link FindPlaceQuery}.
 */
export interface GeoPoint {
	lat: number
	lon: number
}

/**
 * Represents a WGS-84 bounding box, used as a hard filter by {@link FindPlaceQuery}.
 */
export interface GeoBbox {
	minLat: number
	maxLat: number
	minLon: number
	maxLon: number
}

/**
 * Describes a place lookup.
 * Every field except `text` narrows or ranks the search.
 *
 * An extract without the R*Tree index silently ignores `bbox` and `near.maxDistanceKm`.
 */
export interface FindPlaceQuery {
	text: string
	placetype?: WOFPlacetype | WOFPlacetype[]

	/**
	 * Restricts matches to one ISO 3166-1 alpha-2 country.
	 */
	country?: string

	/**
	 * Restricts the typo-fuzzy tier to one ISO 3166-1 alpha-2 country.
	 * Exact matches stay worldwide.
	 *
	 * A fuzzy miss in this country returns nothing and does not fall back to a worldwide correction.
	 * The field is ignored when `country` is set.
	 */
	fuzzyCountry?: string

	/**
	 * Whether to match only primary names.
	 *
	 * Probes that re-read a token from a longer span set it because that token was never an alias.
	 */
	primaryOnly?: boolean

	/**
	 * Alias name roles, such as `abbr` or `gloss`, that the probe excludes.
	 *
	 * Rows with no role, and artifacts without a role column, are unaffected.
	 */
	excludeNameRoles?: readonly string[]

	/**
	 * Restricts matches to descendants of this WOF place id.
	 */
	parentID?: number

	/**
	 * The sibling postcode for a `locality` query.
	 *
	 * When a `postcode_locality` table exists, the lookup adds that postcode's localities
	 * and scores them on a weighted blend of postcode, name and population evidence.
	 * This finds small localities that a name match misses.
	 */
	postcode?: string

	/**
	 * Whether a locality query with `postcode` moves candidates near the postcode's
	 * centroid to the front, sorted by distance.
	 * The remaining candidates keep their order.
	 */
	postcodeContainmentCoherence?: boolean

	/**
	 * The parsed region qualifier for a locality lookup.
	 *
	 * A backend with the ancestors sidecar marks contained candidates and ranks them first.
	 * It may also add contained candidates that a country scope hid.
	 * It never removes candidates.
	 */
	regionQualifier?: string

	/**
	 * A proximity hint that boosts nearby candidates.
	 * It filters by radius only when `maxDistanceKm` is set.
	 */
	near?: GeoPoint & { maxDistanceKm?: number }

	/**
	 * Ordered proximity-bias points, such as a viewport center or user location.
	 * Each point has an optional weight that defaults to 1.
	 *
	 * The bias re-ranks exact-tier candidates by combined prominence and never removes candidates.
	 * The `near` point counts as a bias point of weight 1.
	 */
	bias?: Array<GeoPoint & { weight?: number }>

	/**
	 * Returns only candidates whose bounding box intersects this box.
	 */
	bbox?: GeoBbox

	/**
	 * The maximum number of candidates to return, defaulting to 10.
	 */
	limit?: number
}

/**
 * Resolves a {@link FindPlaceQuery} to ranked {@link PlaceCandidate}s.
 *
 * The method is asynchronous so that a worker-backed implementation can use the same interface.
 */
export interface PlaceLookup extends Disposable {
	findPlace(query: FindPlaceQuery): Promise<PlaceCandidate[]>
}
