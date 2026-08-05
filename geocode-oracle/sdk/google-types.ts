/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The subset of the Google Geocoding API's JSON response this package actually consumes.
 *
 *   WHY THESE ARE HAND-WRITTEN rather than imported from `@googlemaps/google-maps-services-js`, which
 *   is already in this monorepo's tree (`spatial` lists it as a dev + optional dependency and
 *   type-imports `LatLng`/`LatLngLiteral` from it):
 *
 *     1. It is an OPTIONAL dependency of `spatial`, which means a tree where it failed to install is a
 *        supported tree. A client whose entire correctness rests on the response shape should not have
 *        its response shape vanish under an install flag.
 *     2. The isp-nexus original that this port descends from had to write `axiosInstance: this.axios as
 *        any` with the comment "Fixes outdated type definitions" to get the library to accept an Axios
 *        instance at all. Its types were already drifting from the wire in 2024.
 *     3. The `status` union below is the load-bearing part of this file (see {@linkcode
 *        GoogleGeocoderStatus}), and it is small enough to state exactly. Depending on a package for
 *        it buys nothing and hides it.
 *
 *   The runtime dependency on `@googlemaps/google-maps-services-js` is dropped entirely — see
 *   `google-client.ts`'s header for why the library's `Client` was actively harmful under
 *   {@linkcode APIClient}.
 *
 *   Field names are Google's wire keys (`snake_case`), which the house acronym-casing rule
 *   deliberately does not touch: they are string contracts, not identifiers we chose.
 */

/**
 * The `status` field every Geocoding API response carries — Google's IN-BAND error channel.
 *
 * THIS IS THE SINGLE MOST IMPORTANT THING ABOUT THIS API. Every one of these arrives under **HTTP 200**, including the
 * ones that mean "your key is invalid" and "you are over quota". A client that only inspects the HTTP status treats a
 * `REQUEST_DENIED` as a successful geocode with zero results, caches it, and reports an empty answer forever.
 * `google-client.ts` maps each of these onto a `ResourceError` with a synthetic HTTP status so callers branch on
 * `error.status` / `isTransientResourceError(error)` exactly as they do for every other client in this repo.
 *
 * @see https://developers.google.com/maps/documentation/geocoding/requests-geocoding#StatusCodes
 */
export const GoogleGeocoderStatus = {
	/**
	 * At least one result was returned, and no errors occurred.
	 */
	OK: "OK",
	/**
	 * The geocode succeeded but returned no results. A LEGITIMATE, CACHEABLE ANSWER: the address does not resolve, and
	 * asking again tomorrow will not change that.
	 */
	ZeroResults: "ZERO_RESULTS",
	/**
	 * The daily request quota for the billing account is exhausted.
	 */
	OverDailyLimit: "OVER_DAILY_LIMIT",
	/**
	 * The per-second/per-minute request rate was exceeded. TRANSIENT — the one status here worth retrying.
	 */
	OverQueryLimit: "OVER_QUERY_LIMIT",
	/**
	 * The request was rejected: usually a missing, invalid, restricted, or unbilled API key.
	 */
	RequestDenied: "REQUEST_DENIED",
	/**
	 * The request is malformed — no `address`/`latlng`/`place_id`, or an unparseable one.
	 */
	InvalidRequest: "INVALID_REQUEST",
	/**
	 * A server-side error. Google's own documentation says to retry.
	 */
	UnknownError: "UNKNOWN_ERROR",
} as const

/**
 * The `status` field every Geocoding API response carries. See {@linkcode GoogleGeocoderStatus}.
 */
export type GoogleGeocoderStatus = (typeof GoogleGeocoderStatus)[keyof typeof GoogleGeocoderStatus]

/**
 * How precise Google considers the returned coordinate. Maps onto mailwoman's `ResolutionTier` in `google-parser.ts` —
 * that mapping is what lets an oracle run fill a `SeedCase.expectTier`.
 */
export const GoogleLocationType = {
	/**
	 * A precise geocode for a specific street address.
	 */
	Rooftop: "ROOFTOP",
	/**
	 * Interpolated between two precise points along a street segment — the same technique the Census geocoder uses for
	 * every one of its matches.
	 */
	RangeInterpolated: "RANGE_INTERPOLATED",
	/**
	 * The geometric centre of a result: a street centreline, a polyline, or a polygon (a region or parcel).
	 */
	GeometricCenter: "GEOMETRIC_CENTER",
	/**
	 * Approximate — in practice an administrative or postal-area centroid.
	 */
	Approximate: "APPROXIMATE",
} as const

/**
 * How precise Google considers the returned coordinate.
 */
export type GoogleLocationType = (typeof GoogleLocationType)[keyof typeof GoogleLocationType]

/**
 * One `address_components` entry. `types` is an array because Google tags a single component with every category that
 * applies to it (a component is routinely both `locality` and `political`).
 */
export interface GoogleAddressComponent {
	/**
	 * The full text of the component — `"New South Wales"`, `"Île-de-France"`.
	 */
	long_name: string
	/**
	 * The abbreviated form where one exists, otherwise identical to `long_name` — `"NSW"`, `"IDF"`, `"US"`.
	 */
	short_name: string
	/**
	 * Every category Google assigns this component.
	 */
	types: string[]
}

/**
 * A `{ lat, lng }` pair. Structurally identical to `@googlemaps/google-maps-services-js`'s `LatLngLiteral`, which is
 * what `GeoPoint`'s constructor overload and `GeoPoint.toGoogleLatLngLiteral()` speak.
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
	 * Absent on some responses, which is why the tier mapping treats a missing value as "unknown" rather than defaulting
	 * to a tier.
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
	/**
	 * The globally unambiguous form, e.g. `"8FW4V75V+8Q"`. This is the one carried onto `OracleGeocodeResult.plusCode`.
	 */
	global_code: string
	/**
	 * The shortened form relative to a named locality, e.g. `"V75V+8Q Paris, France"`. Only present when a suitable
	 * reference locality exists.
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
	/**
	 * Google's stable identifier for the matched place.
	 */
	place_id: string
	plus_code?: GooglePlusCode
	/**
	 * Every category Google assigns the RESULT (as opposed to its components) — `"street_address"`, `"premise"`,
	 * `"postal_code"`, `"establishment"`.
	 */
	types: string[]
	/**
	 * Set (and only set) when Google could not match the query as given and fell back to something looser. ABSENT means
	 * exact, which is why {@linkcode OracleGeocodeResult.partialMatch} coerces rather than passes through.
	 */
	partial_match?: boolean
	/**
	 * Present only for `postal_code` results that span several localities.
	 */
	postcode_localities?: string[]
}

/**
 * The full response body. `results` is always present (empty on `ZERO_RESULTS`); `error_message` only accompanies a
 * failing `status`.
 */
export interface GoogleGeocodeResponse {
	results: GoogleGeocodeResult[]
	status: GoogleGeocoderStatus | string
	/**
	 * Google's human-readable explanation of a failing `status`. Never contains the API key — it is safe to surface in an
	 * error message, and `google-client.ts` does.
	 */
	error_message?: string
}
