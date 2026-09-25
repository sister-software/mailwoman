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
 * Describes one ranked match for a place lookup, where `score` is ordinal only
 * and `distanceKm` is set only when the query carried `near`.
 *
 * `id` is the WOF id, named generically so the shape satisfies `@mailwoman/resolver`'s
 * `ResolvedPlace` without an adapter.
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
	 * Absence means the artifact has no sidecar, not that the place is a root.
	 * It lets a consumer see that a locality and a same-name `localadmin` in one answer are
	 * one settlement at two tiers, though deciding that remains the consumer's call.
	 */
	parent_id?: number
	score: number
	distanceKm?: number

	/**
	 * Whether the candidate's name or an alias exactly equals the query,
	 * so a later re-rank can stay within the exact-match tier.
	 */
	exactMatch?: boolean

	/**
	 * The population term plus the best proximity-bias term, in the same additive units.
	 *
	 * The exact tier sorts by this instead of population when the query carries `near` or `bias`.
	 */
	prominence?: number

	/**
	 * The WOF `wof:population` value; absence means unknown, not zero.
	 */
	population?: number

	/**
	 * The referential likelihood in [0, 1], derived from {@link PlaceCandidate.population}.
	 *
	 * It orders candidates the same way population does, and it is absent whenever population is.
	 */
	referential?: number

	/**
	 * The strict encyclopedia-evidence importance in [0, 1], carried for display and never used for ranking.
	 *
	 * It is present only when the extract's `place_importance` table has the
	 * split columns; absence is not zero.
	 */
	encyclopedic?: number

	/**
	 * The blended toponym prior in [0, 1] that `rankByImportance` reads for bare toponyms.
	 *
	 * Only the candidate-table backend emits it, and absence means unmeasured, not zero.
	 */
	importance?: number

	/**
	 * The place's bounding box from the WOF `spr` extent columns, omitted when the schema lacks them.
	 */
	bbox?: GeoBbox

	/**
	 * Set by the postcode path when the chosen locality is far from the sibling postcode's own locality.
	 *
	 * The candidate is still returned, so callers can lower confidence instead of silently mislocating.
	 */
	mismatch?: boolean

	/**
	 * Whether the ancestors sidecar places this candidate under the
	 * query's {@link FindPlaceQuery.regionQualifier}.
	 *
	 * `false` means evaluated and not contained; absence means not evaluated and must not be read as `false`.
	 */
	containedByQualifier?: boolean

	/**
	 * Present only when the candidate would have taken the cross-country alias penalty
	 * and the variant exemption prevented it.
	 *
	 * Only the candidate-table backend emits it, so absence elsewhere means not evaluated.
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
 * Describes a place lookup, where `text` is required and every other field narrows or ranks the search.
 *
 * `near` only boosts nearby candidates unless it carries `maxDistanceKm`, and `bbox`
 * and that radius filter are silently ignored on an extract without the R*Tree index.
 */
export interface FindPlaceQuery {
	text: string
	placetype?: WOFPlacetype | WOFPlacetype[]

	/**
	 * Restricts matches to one ISO 3166-1 alpha-2 country.
	 */
	country?: string

	/**
	 * Restricts only the typo-fuzzy tier to one ISO 3166-1 alpha-2 country,
	 * while exact matches stay worldwide.
	 *
	 * A scoped fuzzy miss abstains instead of falling back to a worldwide correction,
	 * and the field is ignored when `country` is set.
	 */
	fuzzyCountry?: string

	/**
	 * Whether to match only primary names, for probes that re-read a token out of
	 * a longer span and so never named an alias.
	 */
	primaryOnly?: boolean

	/**
	 * Alias name roles, such as `abbr` or `gloss`, that may not answer the probe;
	 * rows with no role and artifacts without a role column are unaffected.
	 */
	excludeNameRoles?: readonly string[]

	/**
	 * Restricts matches to descendants of this WOF place id.
	 */
	parentID?: number

	/**
	 * The sibling postcode for a `locality` query.
	 *
	 * When a `postcode_locality` table exists, the lookup injects that postcode's localities
	 * and scores them on a weighted blend of postcode, name and population evidence,
	 * which recovers small localities a name match misses.
	 */
	postcode?: string

	/**
	 * Whether a locality query with `postcode` sorts candidates near the postcode's
	 * centroid first by distance, keeping the rest in their original order.
	 */
	postcodeContainmentCoherence?: boolean

	/**
	 * The parsed region qualifier for a locality lookup.
	 *
	 * A capable backend marks and ranks contained candidates first and may add contained candidates that
	 * a country scope hid, but never filters; artifacts without the ancestors sidecar ignore it.
	 */
	regionQualifier?: string

	/**
	 * A proximity hint that boosts nearby candidates, and filters by radius only when `maxDistanceKm` is set.
	 */
	near?: GeoPoint & { maxDistanceKm?: number }

	/**
	 * Ordered proximity-bias points, such as a viewport center or user location,
	 * each with an optional weight that defaults to 1.
	 *
	 * The bias re-ranks exact-tier candidates by combined prominence and never filters;
	 * `near` counts as a weight-1 bias point.
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
 * Resolves a {@link FindPlaceQuery} to ranked {@link PlaceCandidate}s, asynchronously
 * so a worker-backed implementation fits without an API break.
 */
export interface PlaceLookup extends Disposable {
	findPlace(query: FindPlaceQuery): Promise<PlaceCandidate[]>
}
