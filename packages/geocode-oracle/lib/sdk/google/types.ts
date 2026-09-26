/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The subset of the Google Geocoding API's JSON response this package consumes; hand-written because `@googlemaps/google-maps-services-js` is an optional `spatial` dependency a supported install can lack.
 *
 * Field names are Google's wire keys (`snake_case`), which the house acronym-casing rule leaves alone.
 */

/**
 * Google's in-band error channel: every value arrives under HTTP 200, so branching on HTTP
 * status alone records `REQUEST_DENIED` as a successful geocode with zero results.
 *
 * @see https://developers.google.com/maps/documentation/geocoding/requests-geocoding#StatusCodes
 */
export const GoogleGeocoderStatus = {
	OK: "OK",
	/**
	 * A legitimate, cacheable answer: the address does not resolve.
	 */
	ZeroResults: "ZERO_RESULTS",
	OverDailyLimit: "OVER_DAILY_LIMIT",
	/**
	 * Transient; the one status here worth retrying.
	 */
	OverQueryLimit: "OVER_QUERY_LIMIT",
	RequestDenied: "REQUEST_DENIED",
	InvalidRequest: "INVALID_REQUEST",
	/**
	 * A server-side error; Google's documentation says to retry.
	 */
	UnknownError: "UNKNOWN_ERROR",
} as const

/**
 * The `status` field every Geocoding API response carries.
 */
export type GoogleGeocoderStatus = (typeof GoogleGeocoderStatus)[keyof typeof GoogleGeocoderStatus]

/**
 * How precise Google considers the returned coordinate; `google-parser.ts` maps each value
 * onto mailwoman's `ResolutionTier` so an oracle run can fill a `SeedCase.expectTier`.
 */
export const GoogleLocationType = {
	Rooftop: "ROOFTOP",
	RangeInterpolated: "RANGE_INTERPOLATED",
	GeometricCenter: "GEOMETRIC_CENTER",
	Approximate: "APPROXIMATE",
} as const

/**
 * How precise Google considers the returned coordinate.
 */
export type GoogleLocationType = (typeof GoogleLocationType)[keyof typeof GoogleLocationType]

/**
 * One `address_components` entry; `types` is an array because Google tags a single component
 * with every category that applies (a component is routinely both `locality` and `political`).
 */
export interface GoogleAddressComponent {
	long_name: string
	/**
	 * Abbreviated where one exists, otherwise identical to `long_name`.
	 */
	short_name: string
	types: string[]
}

/**
 * A `{ lat, lng }` pair, kept structurally identical to the `LatLngLiteral` `GeoPoint` speaks.
 */
export interface GoogleLatLngLiteral {
	lat: number
	lng: number
}

/**
 * A north-east / south-west corner pair, used for both `bounds` and `viewport`.
 */
export interface GoogleBounds {
	northeast: GoogleLatLngLiteral
	southwest: GoogleLatLngLiteral
}

/**
 * The `geometry` block of a result.
 */
export interface GoogleGeometry {
	location: GoogleLatLngLiteral
	/**
	 * Absent on some responses, which the tier mapping treats as unknown rather than defaulting.
	 */
	location_type?: GoogleLocationType | string
	viewport?: GoogleBounds
	/**
	 * Present only when the result has a meaningful extent (a region, a route, a large premise).
	 */
	bounds?: GoogleBounds
}

/**
 * A result's Open Location Code block.
 */
export interface GooglePlusCode {
	global_code: string
	/**
	 * The shortened form relative to a named locality, present only when one exists.
	 */
	compound_code?: string
}

/**
 * One entry of the `results` array.
 */
export interface GoogleGeocodeResult {
	address_components: GoogleAddressComponent[]
	/**
	 * Google's own single-line rendering of the match, in the requested `language`.
	 */
	formatted_address: string
	geometry: GoogleGeometry
	place_id: string
	plus_code?: GooglePlusCode
	/**
	 * Every category Google assigns the result rather than its components.
	 */
	types: string[]
	/**
	 * Set only when Google could not match the query as given and fell back to something looser;
	 * absent means exact, which `OracleGeocodeResult.partialMatch` coerces rather than passes through.
	 */
	partial_match?: boolean
	/**
	 * Present only for `postal_code` results that span several localities.
	 */
	postcode_localities?: string[]
}

/**
 * The full response body; `results` is always present (empty on `ZERO_RESULTS`)
 * and `error_message` only accompanies a failing `status`.
 */
export interface GoogleGeocodeResponse {
	results: GoogleGeocodeResult[]
	status: GoogleGeocoderStatus | string
	/**
	 * Google's human-readable explanation of a failing `status`; never contains the API key,
	 * so it is safe to surface in an error message.
	 */
	error_message?: string
}
