/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Google Geocoding API client built on {@linkcode APIClient}.
 *
 *   Every request goes through `APIClient.fetch`, which provides pacing, caching, retries and
 *   {@linkcode ResourceError} mapping.
 *
 *   Google reports failures such as `REQUEST_DENIED` and `OVER_QUERY_LIMIT` in the body of an HTTP 200
 *   response. {@linkcode statusToResourceError} maps each in-band status to a synthetic HTTP status, and
 *   {@linkcode isCacheableGoogleBody} keeps failure bodies out of the cache.
 *
 *   The API key travels as an Axios instance-level `params` default, so logged URLs and error messages
 *   do not contain it. {@linkcode geocodeCacheKey} also excludes it, so rotating the key keeps the cache.
 *
 *   Callers branch on the error's `status` and {@linkcode isTransientResourceError}:
 *
 *   | Outcome                                  | Caller action         | Test                              |
 *   | ---------------------------------------- | --------------------- | --------------------------------- |
 *   | `ZERO_RESULTS`                           | Record no match       | `error.status === 404`            |
 *   | `REQUEST_DENIED`                         | Abort the run         | `error.status === 403`            |
 *   | `OVER_DAILY_LIMIT`                       | Abort the run         | `error.status === 402`            |
 *   | `INVALID_REQUEST`                        | Fix the caller        | `error.status === 400`            |
 *   | `OVER_QUERY_LIMIT` / `UNKNOWN_ERROR`     | Requeue after retries | `isTransientResourceError(error)` |
 *   | Exhausted HTTP 429/5xx, network, timeout | Requeue               | `isTransientResourceError(error)` |
 */

import { APIClient, type APIClientConfig, type ClockLike, systemClock } from "@mailwoman/core/api"
import { buildDiskStorage } from "@mailwoman/core/api/disk-storage"
import { dataRootPath } from "@mailwoman/core/data-root"
import { ResourceError } from "@mailwoman/core/errors"
import { stringifyJSON } from "@mailwoman/core/json"
import { GeoPoint, type GeoPointInput, isGooglePlaceID } from "@mailwoman/spatial"
import type { PathBuilderLike } from "path-ts"

import { $private } from "#env"
import type { OracleGeocodeResult } from "#result"
import { parseGoogleGeocodeResult } from "#sdk/google/parser"
import {
	type GoogleGeocodeResponse,
	type GoogleGeocodeResult,
	GoogleGeocoderStatus,
	type GoogleLatLngLiteral,
} from "#sdk/google/types"

/**
 * The Geocoding API endpoint.
 *
 * Forward geocoding, reverse geocoding and Place ID lookup all use this URL.
 * They differ only in whether the request sets `address`, `latlng` or `place_id`.
 */
export const GOOGLE_GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"

/**
 * Default request rate per minute.
 *
 * Google allows 3,000 requests per minute, but every uncached request is billed
 * and the intended workload is a few hundred hand-authored addresses.
 * Callers can raise the rate through {@linkcode CreateGoogleGeocoderClientOptions.requestsPerMinute}.
 */
export const GOOGLE_DEFAULT_REQUESTS_PER_MINUTE = 60

const MS_PER_MINUTE = 60_000

/**
 * Cache lifetime of 30 days.
 *
 * Every cache miss is billed, and rooftop coordinates rarely change.
 * The TTL still bounds how long a cached answer can disagree with a fresh geocode.
 * Deleting the cache directory forces fresh requests.
 */
const DEFAULT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Maximum attempts for a transient failure, including the first attempt.
 *
 * The limit applies both to HTTP-level failures in `APIClient` and to Google's in-band
 * `OVER_QUERY_LIMIT` and `UNKNOWN_ERROR` statuses in {@linkcode GoogleGeocoderClient.request}.
 */
const DEFAULT_MAX_ATTEMPTS = 3

/**
 * Base delay of the exponential retry backoff, in milliseconds.
 */
const DEFAULT_BASE_RETRY_DELAY_MS = 500

/**
 * Per-attempt socket-inactivity timeout, in milliseconds.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/**
 * Synthetic HTTP statuses for Google's in-band failures.
 * Each code keeps its usual HTTP meaning.
 */
const HTTP_BAD_REQUEST = 400
const HTTP_PAYMENT_REQUIRED = 402
const HTTP_FORBIDDEN = 403
const HTTP_NOT_FOUND = 404
const HTTP_TOO_MANY_REQUESTS = 429
const HTTP_INTERNAL_SERVER_ERROR = 500

/**
 * The minimum length at which {@linkcode GoogleGeocoderClient.geocode} treats a string as a Place ID.
 *
 * Google documents Place IDs as generally 27 characters long.
 * The threshold keeps short place names such as `"Paris"` in the address branch.
 */
const GOOGLE_PLACE_ID_MIN_LENGTH = 20

/**
 * Options for {@linkcode createGoogleGeocoderClient}.
 */
export interface CreateGoogleGeocoderClientOptions {
	/**
	 * The Google Maps API key.
	 * Defaults to `$private.GOOGLE_MAPS_API_KEY`.
	 */
	apiKey?: string
	/**
	 * Maximum requests per minute.
	 * Defaults to {@linkcode GOOGLE_DEFAULT_REQUESTS_PER_MINUTE}.
	 */
	requestsPerMinute?: number
	/**
	 * Clock for pacing and both retry backoffs.
	 * Tests inject a fake clock.
	 */
	clock?: ClockLike
	/**
	 * Cache directory.
	 *
	 * Defaults to `dataRootPath("geocode-oracle", "google")`, which the factory resolves
	 * at construction, so `$MAILWOMAN_DATA_ROOT` must be set first.
	 */
	cacheDir?: PathBuilderLike
	/**
	 * Cache lifetime in milliseconds.
	 * Defaults to 30 days.
	 */
	cacheTTLMs?: number
	/**
	 * Maximum attempts for a transient failure.
	 *
	 * The client never retries `REQUEST_DENIED`, `INVALID_REQUEST`, `ZERO_RESULTS` or `OVER_DAILY_LIMIT`.
	 */
	maxAttempts?: number
	/**
	 * Base delay of the exponential retry backoff, in milliseconds.
	 * Attempt `n` waits `baseRetryDelayMs * 2^(n-1)`.
	 */
	baseRetryDelayMs?: number
	/**
	 * Per-attempt socket-inactivity timeout, in milliseconds.
	 */
	requestTimeoutMs?: number
	/**
	 * Default BCP-47 response language.
	 *
	 * When it is unset, Google renders each result in the address's local language,
	 * which suits a multi-country oracle.
	 */
	language?: string
	/**
	 * Axios options merged over the defaults.
	 * Tests inject an adapter here to avoid network calls.
	 *
	 * Replacing `params` entirely would drop the API key.
	 */
	axios?: APIClientConfig["axios"]
}

/**
 * Per-request geocoding options.
 */
export interface GeocodeRequestOptions {
	/**
	 * ISO 3166-1 alpha-2 country code that restricts results.
	 *
	 * The client sends it as `components=country:XX`, which excludes every match outside the country.
	 */
	country?: string
	/**
	 * BCP-47 response language for this request.
	 * It overrides the client default.
	 */
	language?: string
	/**
	 * ccTLD region code, such as `"uk"` or `"es"`, that biases interpretation toward a region.
	 */
	region?: string
	/**
	 * Viewport that biases results, given as southwest and northeast corners.
	 * The client sets no default viewport.
	 */
	bounds?: { southwest: GoogleLatLngLiteral; northeast: GoogleLatLngLiteral }
}

/**
 * {@linkcode APIClient} configuration plus the fields that {@linkcode GoogleGeocoderClient} reads.
 */
export interface GoogleGeocoderClientConfig extends APIClientConfig {
	/**
	 * Default response language.
	 *
	 * When it is `undefined`, Google uses the address's local language.
	 */
	language?: string
	/**
	 * Maximum attempts for Google's in-band transient statuses, which the HTTP-level `retry` cannot see.
	 */
	maxAttempts: number
	/**
	 * Base delay of the in-band retry backoff, in milliseconds.
	 */
	baseRetryDelayMs: number
	/**
	 * Clock for the in-band retry backoff.
	 *
	 * `APIClient` keeps its clock private, so the factory passes the same clock to both.
	 */
	clock: ClockLike
}

/**
 * Query-string parameters for one geocode request, keyed by Google's `snake_case` names.
 */
type GeocodeParams = Record<string, string>

/**
 * Builds the cache key for one request without the API key.
 *
 * Excluding the key keeps cache entries valid across key rotation.
 * Sorting the parameter names makes two requests that differ only in property order share an entry.
 */
export function geocodeCacheKey(config: { method?: string; url?: string; params?: unknown }): string {
	const params = (config.params ?? {}) as Record<string, unknown>

	const names = Object.keys(params)
		.filter((name) => name !== "key")
		.toSorted()

	return `${(config.method ?? "get").toLowerCase()}:${config.url ?? ""}:${stringifyJSON(params, names)}`
}

/**
 * Reports whether a decoded response body is safe to cache.
 *
 * Only `OK` and `ZERO_RESULTS` bodies qualify, because they describe the address.
 * Other statuses describe the request or the account, and caching one such as
 * `REQUEST_DENIED` would repeat the failure for the whole TTL.
 */
export function isCacheableGoogleBody(value: { data?: { data?: unknown } }): boolean {
	const body = value.data?.data as GoogleGeocodeResponse | undefined

	if (!body || typeof body !== "object") return false

	return body.status === GoogleGeocoderStatus.OK || body.status === GoogleGeocoderStatus.ZeroResults
}

/**
 * Returns the synthetic HTTP status and URN reason for one of Google's in-band statuses.
 */
function statusMapping(status: string): { httpStatus: number; reason: string } {
	switch (status) {
		case GoogleGeocoderStatus.ZeroResults:
			return { httpStatus: HTTP_NOT_FOUND, reason: "zero-results" }
		case GoogleGeocoderStatus.RequestDenied:
			return { httpStatus: HTTP_FORBIDDEN, reason: "request-denied" }
		case GoogleGeocoderStatus.OverDailyLimit:
			return { httpStatus: HTTP_PAYMENT_REQUIRED, reason: "over-daily-limit" }
		case GoogleGeocoderStatus.OverQueryLimit:
			return { httpStatus: HTTP_TOO_MANY_REQUESTS, reason: "over-query-limit" }
		case GoogleGeocoderStatus.InvalidRequest:
			return { httpStatus: HTTP_BAD_REQUEST, reason: "invalid-request" }
		case GoogleGeocoderStatus.UnknownError:
			return { httpStatus: HTTP_INTERNAL_SERVER_ERROR, reason: "unknown-error" }
		default:
			return { httpStatus: HTTP_INTERNAL_SERVER_ERROR, reason: "unrecognized-status" }
	}
}

/**
 * Converts a non-`OK` Google response into a {@linkcode ResourceError} with a synthetic HTTP status.
 *
 * A `REQUEST_DENIED` message explains that the API key is the likely cause.
 * The message appends Google's `error_message` when the response includes one.
 */
export function statusToResourceError(body: GoogleGeocodeResponse, description: string): ResourceError {
	const { httpStatus, reason } = statusMapping(body.status)
	const detail = body.error_message ? ` Google said: ${body.error_message}` : ""

	const message =
		body.status === GoogleGeocoderStatus.RequestDenied
			? `Google rejected the geocode request for ${description}: REQUEST_DENIED. This is a KEY problem rather than an ` +
				"address problem — the key is missing, malformed, restricted to referrers/IPs this process does not match, " +
				"or belongs to a project with the Geocoding API disabled or billing unattached. Check " +
				"`GOOGLE_MAPS_API_KEY` against https://console.cloud.google.com/google/maps-apis. Not retried: a rejected " +
				`key cannot succeed on a second attempt, and every attempt is billed.${detail}`
			: `Google geocode for ${description} returned ${body.status}.${detail}`

	return ResourceError.from(httpStatus, message, "google", "response", reason)
}

/**
 * A Google Geocoding API client.
 *
 * Use {@linkcode createGoogleGeocoderClient} to construct one.
 */
export class GoogleGeocoderClient extends APIClient<GoogleGeocoderClientConfig> {
	/**
	 * Forward-geocodes a free-text address.
	 *
	 * The method returns every result in Google's relevance order, because the number
	 * of plausible matches is itself useful to an oracle.
	 */
	public async geocodeAddress(
		address: string,
		options: GeocodeRequestOptions = {}
	): Promise<OracleGeocodeResult<GoogleGeocodeResult>[]> {
		if (!address.trim()) {
			throw ResourceError.from(
				HTTP_BAD_REQUEST,
				"geocodeAddress: address must be non-empty.",
				"google",
				"request",
				"empty-address"
			)
		}

		return this.request({ address }, options, `address "${address}"`)
	}

	/**
	 * Reverse-geocodes a coordinate.
	 *
	 * `GeoPoint.from` returns `null` for an out-of-range or transposed coordinate instead of repairing it.
	 * The method throws in that case instead of sending a billed request.
	 */
	public async reverseGeocode(
		input: GeoPointInput,
		options: GeocodeRequestOptions = {}
	): Promise<OracleGeocodeResult<GoogleGeocodeResult>[]> {
		const point = GeoPoint.from(input)

		if (!point) {
			throw ResourceError.from(
				HTTP_BAD_REQUEST,
				`reverseGeocode: ${stringifyJSON(input)} is not a coordinate this client will stand behind. Coordinate ` +
					"pairs are GeoJSON [longitude, latitude]; an out-of-range magnitude, and 0/0, are both rejected rather " +
					"than repaired (see GeoPoint.from).",
				"google",
				"request",
				"invalid-coordinate"
			)
		}

		const { lat, lng } = point.toGoogleLatLngLiteral()

		return this.request({ latlng: `${lat},${lng}` }, options, `point ${lat},${lng}`)
	}

	/**
	 * Looks up a Google Place ID.
	 *
	 * Google advises treating a Place ID as stale after a few days, so a test case should not depend on one.
	 */
	public async geocodePlaceID(
		placeID: string,
		options: GeocodeRequestOptions = {}
	): Promise<OracleGeocodeResult<GoogleGeocodeResult>[]> {
		if (!isGooglePlaceID(placeID)) {
			throw ResourceError.from(
				HTTP_BAD_REQUEST,
				`geocodePlaceID: "${placeID}" is not shaped like a Google Place ID (base64url characters only).`,
				"google",
				"request",
				"invalid-place-id"
			)
		}

		return this.request({ place_id: placeID }, options, `place ID ${placeID}`)
	}

	/**
	 * Geocodes a coordinate object, a Place ID string or a free-text address, chosen by the input's shape.
	 *
	 * The method always treats a string as a Place ID or an address.
	 * A string such as `"48.85, 2.29"` has an ambiguous axis order, so a caller with
	 * a coordinate passes an object or a `GeoPoint`.
	 */
	public async geocode(
		input: string | GeoPointInput,
		options: GeocodeRequestOptions = {}
	): Promise<OracleGeocodeResult<GoogleGeocodeResult>[]> {
		if (typeof input !== "string") return this.reverseGeocode(input, options)

		const trimmed = input.trim()

		if (!trimmed) {
			throw ResourceError.from(
				HTTP_BAD_REQUEST,
				"geocode: input must be non-empty.",
				"google",
				"request",
				"empty-input"
			)
		}

		// `isGooglePlaceID` checks only the character class, which a word like "Paris" also passes.
		// The length and `_`/`-` tests keep addresses out of the Place ID branch.
		// A misrouted Place ID still geocodes as an address, but a misrouted address fails as `INVALID_REQUEST`.
		if (trimmed.length >= GOOGLE_PLACE_ID_MIN_LENGTH && /[_-]/.test(trimmed) && isGooglePlaceID(trimmed)) {
			return this.geocodePlaceID(trimmed, options)
		}

		return this.geocodeAddress(trimmed, options)
	}

	/**
	 * Sends one geocode request and parses the results.
	 *
	 * `APIClient` retries only HTTP-level failures.
	 * This loop retries Google's in-band `OVER_QUERY_LIMIT` and `UNKNOWN_ERROR` statuses,
	 * and each attempt goes back through `fetch` and its pacer.
	 *
	 * @internal
	 */
	protected async request(
		query: GeocodeParams,
		options: GeocodeRequestOptions,
		description: string
	): Promise<OracleGeocodeResult<GoogleGeocodeResult>[]> {
		const params: GeocodeParams = { ...query }
		const language = options.language ?? this.config.language

		if (language) {
			params.language = language
		}

		if (options.region) {
			params.region = options.region
		}

		if (options.country) {
			params.components = `country:${options.country}`
		}

		if (options.bounds) {
			const { southwest, northeast } = options.bounds

			params.bounds = `${southwest.lat},${southwest.lng}|${northeast.lat},${northeast.lng}`
		}

		for (let attempt = 1; ; attempt++) {
			const response = await this.fetch<GoogleGeocodeResponse>({ url: GOOGLE_GEOCODE_URL, params })
			const body = response.data

			if (body.status === GoogleGeocoderStatus.OK) {
				return body.results.map(parseGoogleGeocodeResult)
			}

			const error = statusToResourceError(body, description)

			const retryable =
				body.status === GoogleGeocoderStatus.OverQueryLimit || body.status === GoogleGeocoderStatus.UnknownError

			if (!retryable || attempt >= this.config.maxAttempts) throw error

			const waitMs = this.config.baseRetryDelayMs * 2 ** (attempt - 1)

			this.logger.debug(`Retrying ${description} in ${waitMs}ms (attempt ${attempt}/${this.config.maxAttempts}).`)

			await this.config.clock.sleep(waitMs)
		}
	}
}

/**
 * Creates a Google Geocoding API client.
 *
 * @throws {Error} When neither `apiKey` nor `GOOGLE_MAPS_API_KEY` provides a key.
 */
export function createGoogleGeocoderClient(options: CreateGoogleGeocoderClientOptions = {}): GoogleGeocoderClient {
	const apiKey = options.apiKey ?? $private.GOOGLE_MAPS_API_KEY

	if (!apiKey) {
		throw new Error(
			"createGoogleGeocoderClient: missing a Google Maps API key. Pass `apiKey` explicitly, or set the " +
				"`GOOGLE_MAPS_API_KEY` environment variable (a Maps Platform key with the Geocoding API enabled and " +
				"billing attached). Failing fast here avoids burning a request on a call that is certain to come back " +
				"REQUEST_DENIED — under an HTTP 200, which is the failure mode this client exists to make legible."
		)
	}

	const requestsPerMinute = Math.max(1, options.requestsPerMinute ?? GOOGLE_DEFAULT_REQUESTS_PER_MINUTE)
	const clock = options.clock ?? systemClock

	return new GoogleGeocoderClient({
		displayName: "Google Geocoder",
		language: options.language,
		maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
		baseRetryDelayMs: options.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS,
		clock,
		// The minimum interval spaces requests evenly.
		// The per-minute budget alone would allow bursts.
		requestsPerMinute,
		minRequestIntervalMs: Math.ceil(MS_PER_MINUTE / requestsPerMinute),
		retry: {
			maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
			baseDelayMs: options.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS,
		},
		caching: {
			storage: buildDiskStorage({
				directory: options.cacheDir ?? dataRootPath("geocode-oracle", "google"),
				validate: isCacheableGoogleBody,
			}),
			ttl: options.cacheTTLMs ?? DEFAULT_CACHE_TTL_MS,
			// The configured TTL overrides Google's `Cache-Control` header.
			interpretHeader: false,
			generateKey: geocodeCacheKey,
		},
		axios: {
			// Axios merges this default into every request's query string.
			// The key therefore stays out of `config.url`, which `APIClient` logs and error messages quote.
			params: { key: apiKey },
			timeout: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
			responseType: "json",
			// A malformed or HTML body raises a parse error instead of passing through as a typed response.
			transitional: { silentJSONParsing: false },
			...options.axios,
		},
	})
}
