/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Google Geocoding API client, built on {@linkcode APIClient}. Ported from
 *   `isp-nexus/universe/mailwoman/sdk/google/GoogleGeocoder.ts`, with the plumbing rewritten onto this
 *   repo's own implementation and three defects from the original fixed rather than carried.
 *
 *   **THE `@googlemaps/google-maps-services-js` DEPENDENCY IS DROPPED.** The original constructed the
 *   library's `Client` around this client's Axios instance (`axiosInstance: this.axios as any // Fixes
 *   outdated type definitions`) and then called `client.geocode(...)` — which dispatches through that
 *   instance DIRECTLY, never through `APIClient.fetch`. The consequence was invisible and total: pacing
 *   and caching still applied (they live in the adapter and the interceptor chain), but the bounded
 *   retry loop and the entire `ResourceError` mapping did not, because both live in `fetch`. Every
 *   failure surfaced as a raw `AxiosError` wrapped in a message string. Talking to the plain REST
 *   endpoint through `fetch` restores all of it, and costs one hand-written response type
 *   (`./google-types.ts`) for three query-string shapes.
 *
 *   **GOOGLE'S ERRORS ARRIVE UNDER HTTP 200.** `REQUEST_DENIED`, `OVER_QUERY_LIMIT`, `INVALID_REQUEST`
 *   and `UNKNOWN_ERROR` are all 200s carrying a `status` field, so nothing in the HTTP layer — not
 *   Axios's `validateStatus`, not `APIClient`'s retry classifier, not the cache's status predicate —
 *   can see them. Two mechanisms handle that here, and both are the reason this file is longer than
 *   `sec-client.ts`: {@linkcode statusToResourceError} maps the in-band status onto the same
 *   `ResourceError` contract every other client in this repo throws, and {@linkcode isCacheableGoogleBody}
 *   refuses to persist any body that is not a real answer. Without the second one, a single
 *   `REQUEST_DENIED` from an unbilled key would be cached for thirty days and every subsequent run
 *   would report the same failure without issuing a request.
 *
 *   **THE API KEY NEVER ENTERS A LOG, A CACHE KEY, OR A FILENAME.** It is carried as an Axios
 *   INSTANCE-level `params` default rather than being concatenated into the request URL, so
 *   `APIClient`'s `logger.debug("GET: <url>")` and every `ResourceError` built off `error.config.url`
 *   see a key-free URL. {@linkcode geocodeCacheKey} then strips it back out before the cache key is
 *   built — belt and braces (the on-disk filename is already a SHA-256 of that key, and
 *   `axios-cache-interceptor` never persists `config`), but it also means ROTATING THE KEY DOES NOT
 *   ORPHAN THE CACHE, which on a billed API is the difference between a free re-run and a paid one.
 *
 *   ERROR CONTRACT. Every failure past construction is a {@linkcode ResourceError}, so a sweep branches
 *   on `status` plus {@linkcode isTransientResourceError} and never on message prose:
 *
 *   | Outcome                                    | Caller action    | Test                                       |
 *   | ------------------------------------------ | ---------------- | ------------------------------------------ |
 *   | `ZERO_RESULTS`                             | no match, move on| `error.status === 404`                      |
 *   | `REQUEST_DENIED`                           | abort the run    | `error.status === 403`                      |
 *   | `OVER_DAILY_LIMIT`                         | abort the run    | `error.status === 402`                      |
 *   | `INVALID_REQUEST`                          | programmer bug   | `error.status === 400`                      |
 *   | `OVER_QUERY_LIMIT` / `UNKNOWN_ERROR`       | retried, then requeue | `isTransientResourceError(error)`      |
 *   | exhausted HTTP 429/5xx, network, timeout   | requeue          | `isTransientResourceError(error)`           |
 */

import { APIClient, type APIClientConfig, type ClockLike, systemClock } from "@mailwoman/core/api"
import { buildDiskStorage } from "@mailwoman/core/api/disk-storage"
import { $private } from "@mailwoman/core/env"
import { ResourceError } from "@mailwoman/core/errors"
import { dataRootPath } from "@mailwoman/core/utils"
import { GeoPoint, type GeoPointInput, isGooglePlaceID } from "@mailwoman/spatial"

import type { OracleGeocodeResult } from "#result"
import { parseGoogleGeocodeResult } from "#sdk/google-parser"
import {
	type GoogleGeocodeResponse,
	type GoogleGeocodeResult,
	GoogleGeocoderStatus,
	type GoogleLatLngLiteral,
} from "#sdk/google-types"

/**
 * The Geocoding API endpoint every request in this file is issued against. Forward AND reverse geocoding and place-ID
 * lookup are all this one URL — they differ only in which of `address` / `latlng` / `place_id` is supplied.
 */
export const GOOGLE_GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"

/**
 * What this client paces at by default: **60 requests per minute**, one per second.
 *
 * Google's published per-project ceiling for the Geocoding API is 3,000 requests per minute — fifty times this. The
 * default is deliberately nowhere near it, because the constraint that actually binds an oracle run is not the rate
 * limit, it is the BILL: every uncached request is charged, and the intended workload is a few hundred addresses
 * authored into gauntlet cases by a human, not a pipeline. One per second finishes 160 addresses in under three minutes
 * on a cold cache and costs nothing on a warm one.
 *
 * Raise it via {@linkcode CreateGoogleGeocoderClientOptions.requestsPerMinute} for a genuinely large sweep. This is a
 * default, not a clamp — unlike `SEC_DEFAULT_REQUESTS_PER_SECOND`, which clamps because SEC's limit is policed and
 * verifiable in fetchable HTML. Google's is enforced by returning `OVER_QUERY_LIMIT` under a 200, which this client
 * already retries.
 */
export const GOOGLE_DEFAULT_REQUESTS_PER_MINUTE = 60

/**
 * Milliseconds in a minute — the numerator when turning a requests/minute budget into a pacing interval.
 */
const MS_PER_MINUTE = 60_000

/**
 * How long a cached geocode stays fresh: **30 days**.
 *
 * Chosen against what the cache is FOR. A gauntlet case is authored once and then re-read on every subsequent run of
 * the sweep that produced it, so the re-read is the common access and each miss is a billed request. The underlying
 * answer barely moves: a street address's rooftop coordinate is stable over years, and the thing that genuinely does
 * drift — Google's Place IDs, which its own documentation warns to treat as stale after a few days — is carried on the
 * result for provenance and is not what any assertion is pinned to.
 *
 * Not permanent, either. `sec-client.ts` earns a century-long TTL because a filed SEC document is immutable by law;
 * nothing here is. Thirty days bounds how long a re-authored case can disagree with a fresh geocode without anyone
 * noticing, and deleting the cache directory is always the override.
 */
const DEFAULT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Total attempts (including the first) before giving up on a transient failure — HTTP 429/5xx and network-class
 * failures via `APIClient`'s retry loop, and Google's 200-wrapped `OVER_QUERY_LIMIT`/`UNKNOWN_ERROR` via
 * {@linkcode GoogleGeocoderClient.request}.
 */
const DEFAULT_MAX_ATTEMPTS = 3

/**
 * Base delay for the exponential backoff between retry attempts, in milliseconds.
 */
const DEFAULT_BASE_RETRY_DELAY_MS = 500

/**
 * Per-attempt socket-inactivity timeout, in milliseconds. A geocode response is a few kilobytes; anything slower than
 * this has stalled.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/**
 * The synthetic HTTP statuses Google's in-band failures are reported under. Chosen so the numbers a caller already
 * branches on keep their usual meaning: 404 is "not found", 403 is "your credentials were refused", 429 is "slow down",
 * 402 is "this is a billing problem", 400 is "the request was wrong", 500 is "their fault, try again".
 */
const HTTP_BAD_REQUEST = 400
const HTTP_PAYMENT_REQUIRED = 402
const HTTP_FORBIDDEN = 403
const HTTP_NOT_FOUND = 404
const HTTP_TOO_MANY_REQUESTS = 429
const HTTP_INTERNAL_SERVER_ERROR = 500

/**
 * The shortest string {@linkcode GoogleGeocoderClient.geocode} will treat as a Place ID rather than as an address.
 * Google's own documentation describes the identifier as "generally a 27-character string"; nothing shorter than this
 * has ever been one, and `"Paris"` must not be mistaken for one.
 */
const GOOGLE_PLACE_ID_MIN_LENGTH = 20

/**
 * Options for {@linkcode createGoogleGeocoderClient}.
 */
export interface CreateGoogleGeocoderClientOptions {
	/**
	 * The Google Maps API key. Defaults to `$private.GOOGLE_MAPS_API_KEY` when omitted.
	 */
	apiKey?: string
	/**
	 * Requests per minute this client will dispatch. Defaults to {@linkcode GOOGLE_DEFAULT_REQUESTS_PER_MINUTE}, which is
	 * far below Google's published ceiling on purpose — see that constant.
	 */
	requestsPerMinute?: number
	/**
	 * Time source powering the pacer, the cooldown timer, and BOTH retry backoffs. Defaults to the system clock; tests
	 * inject a fake one so no suite ever sleeps on the wall clock.
	 */
	clock?: ClockLike
	/**
	 * On-disk cache root. Defaults to `dataRootPath("geocode-oracle", "google")`, resolved once at construction —
	 * construct the client after setting `$MAILWOMAN_DATA_ROOT`, not before.
	 */
	cacheDir?: string
	/**
	 * How long a cached geocode stays fresh, in milliseconds. See {@linkcode DEFAULT_CACHE_TTL_MS}.
	 */
	cacheTTLMs?: number
	/**
	 * Total attempts (including the first) before giving up on a transient failure. A STATED CEILING, not "until it
	 * works". Never applies to `REQUEST_DENIED`, `INVALID_REQUEST`, `ZERO_RESULTS` or `OVER_DAILY_LIMIT`.
	 */
	maxAttempts?: number
	/**
	 * Base delay for the exponential backoff between retry attempts, in milliseconds. Attempt `n` waits `baseRetryDelayMs
	 *
	 * - 2^(n-1)`.
	 */
	baseRetryDelayMs?: number
	/**
	 * Per-attempt socket-inactivity timeout, in milliseconds.
	 */
	requestTimeoutMs?: number
	/**
	 * The BCP-47 language every response is rendered in, unless overridden per request.
	 *
	 * Left UNSET by default, which is not the same as `"en"`: with no `language`, Google renders each result in the local
	 * language of the address, which is the form an oracle for ~160 countries wants — a Japanese address in Japanese, a
	 * Greek one in Greek. The isp-nexus original hardcoded `"en-US"` on every request, which is right for a US pipeline
	 * and wrong here.
	 */
	language?: string
	/**
	 * Axios overrides, merged over this client's own defaults. THE TEST SEAM: every test passes an `adapter` here, so no
	 * test in this workspace performs a live network call. Overriding `params` wholesale would drop the API key, so
	 * don't.
	 */
	axios?: APIClientConfig["axios"]
}

/**
 * Per-request overrides. These are the biasing levers the isp-nexus original hardcoded; see
 * {@linkcode GeocodeRequestOptions.bounds} for the one that mattered.
 */
export interface GeocodeRequestOptions {
	/**
	 * Restrict results to a country, as an ISO-3166 alpha-2 code. Sent as Google's `components=country:XX` filter, which
	 * is a HARD restriction, not a bias — a match outside the country is not returned at all.
	 *
	 * This is the lever a per-country oracle sweep wants: it stops `"Springfield"` resolving to Illinois when the case
	 * under authorship is Neuseeland's.
	 */
	country?: string
	/**
	 * The BCP-47 language for this response, overriding the client-wide default. See
	 * {@linkcode CreateGoogleGeocoderClientOptions.language}.
	 */
	language?: string
	/**
	 * The ccTLD region code (`"uk"`, `"es"`) whose interpretation Google should prefer. A SOFT bias, unlike
	 * {@linkcode GeocodeRequestOptions.country}.
	 */
	region?: string
	/**
	 * A viewport to bias results toward, as `southwest|northeast` latitude/longitude pairs. A SOFT bias.
	 *
	 * THE ORIGINAL HARDCODED ONE OF THESE ON EVERY FORWARD GEOCODE — a bounding box around the contiguous United States,
	 * with no way to turn it off. That was correct for the US-only broadband pipeline it lived in and is precisely wrong
	 * for this package's stated purpose, so it is an opt-in per-request parameter here and there is no default.
	 */
	bounds?: { southwest: GoogleLatLngLiteral; northeast: GoogleLatLngLiteral }
}

/**
 * {@linkcode APIClient} configuration plus the fields {@linkcode GoogleGeocoderClient} reads back off `config`.
 */
export interface GoogleGeocoderClientConfig extends APIClientConfig {
	/**
	 * The client-wide response language, or `undefined` to let Google pick the address's local language.
	 */
	language?: string
	/**
	 * Total attempts for Google's 200-wrapped transient statuses. Mirrors the HTTP-level ceiling in `retry`, which cannot
	 * see them.
	 */
	maxAttempts: number
	/**
	 * Base delay for the in-band retry backoff, in milliseconds.
	 */
	baseRetryDelayMs: number
	/**
	 * The clock the in-band retry backoff sleeps on. `APIClient` keeps its own copy private, so this is a second
	 * reference to the SAME instance — `createGoogleGeocoderClient` passes one value to both.
	 */
	clock: ClockLike
}

/**
 * The query-string parameters one geocode request carries. Google's wire keys, so `snake_case`.
 */
type GeocodeParams = Record<string, string>

/**
 * Build the cache key for one request, with the API key REMOVED.
 *
 * Two things this buys, in order of how much they matter:
 *
 * 1. **The cache survives key rotation.** The key is an instance-level Axios `params` default, so the interceptor's stock
 *    key generator would fold it in and a rotated key would silently orphan every entry — on an API where a miss is a
 *    charge.
 * 2. **No key material is derivable from anything on disk.** Already true without this (`buildDiskStorage` names files by
 *    the SHA-256 of the key, and `axios-cache-interceptor` persists `data`/`ttl`/`createdAt`/`state`, never `config`),
 *    but a secret that is never put into the string in the first place cannot leak from it later.
 *
 * The remaining params are serialized through a SORTED key list so two requests differing only in property order share
 * an entry. `JSON.stringify`'s array replacer both filters and orders, which is exactly the primitive needed.
 */
export function geocodeCacheKey(config: { method?: string; url?: string; params?: unknown }): string {
	const params = (config.params ?? {}) as Record<string, unknown>

	const names = Object.keys(params)
		.filter((name) => name !== "key")
		.toSorted()

	return `${(config.method ?? "get").toLowerCase()}:${config.url ?? ""}:${JSON.stringify(params, names)}`
}

/**
 * Whether a decoded response body is one worth persisting.
 *
 * Only `OK` and `ZERO_RESULTS` are. `ZERO_RESULTS` is included deliberately — it is a real, stable answer ("this string
 * does not geocode"), and re-asking it tomorrow costs a charge to learn the same thing. Everything else describes the
 * REQUEST or the ACCOUNT rather than the address: a `REQUEST_DENIED` cached under a thirty-day TTL would make an
 * unbilled key look like a permanently broken address, self-healing only by hand-deleting a hash-named file. That is
 * the exact failure `core/api/disk-storage.ts` names as the reason `validate` exists.
 */
export function isCacheableGoogleBody(value: { data?: { data?: unknown } }): boolean {
	const body = value.data?.data as GoogleGeocodeResponse | undefined

	if (!body || typeof body !== "object") return false

	return body.status === GoogleGeocoderStatus.OK || body.status === GoogleGeocoderStatus.ZeroResults
}

/**
 * The synthetic HTTP status and URN reason for one of Google's in-band statuses.
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
 * Map a non-`OK` Google response onto the repo's standard {@linkcode ResourceError}, so `error.status` and
 * `isTransientResourceError(error)` mean here what they mean for every other client — even though the wire said 200.
 *
 * `REQUEST_DENIED` gets the long explanation, for the same reason `sec-client.ts` explains a 403 and
 * `bdc/sdk/client.ts` explains a 401: the bare status reads as "the address is bad" and sends the reader down the wrong
 * path, when the cause is almost always the key. Google's own `error_message` is appended when present — it names the
 * actual problem ("This API project is not authorized to use this API") and never contains the key.
 */
export function statusToResourceError(body: GoogleGeocodeResponse, description: string): ResourceError {
	const { httpStatus, reason } = statusMapping(body.status)
	const detail = body.error_message ? ` Google said: ${body.error_message}` : ""

	const message =
		body.status === GoogleGeocoderStatus.RequestDenied
			? `Google rejected the geocode request for ${description}: REQUEST_DENIED. This is a KEY problem, not an ` +
				"address problem — the key is missing, malformed, restricted to referrers/IPs this process does not match, " +
				"or belongs to a project with the Geocoding API disabled or billing unattached. Check " +
				"`GOOGLE_MAPS_API_KEY` against https://console.cloud.google.com/google/maps-apis. Not retried: a rejected " +
				`key cannot succeed on a second attempt, and every attempt is billed.${detail}`
			: `Google geocode for ${description} returned ${body.status}.${detail}`

	return ResourceError.from(httpStatus, message, "google", "response", reason)
}

/**
 * A Google Geocoding API client. Build one with {@linkcode createGoogleGeocoderClient}, which resolves the key, the
 * pacing, the cache and every default.
 */
export class GoogleGeocoderClient extends APIClient<GoogleGeocoderClientConfig> {
	/**
	 * Forward-geocode a free-text address.
	 *
	 * Results come back in Google's own relevance order; `[0]` is its best guess. The whole array is returned rather than
	 * just the first because an oracle's most useful signal is often that there were three plausible matches.
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
	 * Reverse-geocode a coordinate.
	 *
	 * The input is validated through `GeoPoint.from`, which since #1487 is STRICT: it neither transposes a `[latitude,
	 * longitude]` pair back into GeoJSON order nor repairs an off-globe magnitude, and returns `null` for both. A
	 * rejected coordinate raises here rather than being sent, because a silently transposed pair produces a confident,
	 * wrong, BILLED answer — and the whole point of an oracle is that its answers are trustworthy.
	 */
	public async reverseGeocode(
		input: GeoPointInput,
		options: GeocodeRequestOptions = {}
	): Promise<OracleGeocodeResult<GoogleGeocodeResult>[]> {
		const point = GeoPoint.from(input)

		if (!point) {
			throw ResourceError.from(
				HTTP_BAD_REQUEST,
				`reverseGeocode: ${JSON.stringify(input)} is not a coordinate this client will stand behind. Coordinate ` +
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
	 * Look up a Google Place ID and return it as an address.
	 *
	 * Google Place IDs are not permanent — Google's own documentation says to consider one stale after a few days — so
	 * this is for resolving an ID captured moments ago, not for pinning a gauntlet case to.
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
	 * Dispatch on the shape of `input`: a coordinate object, a Place ID string, or free text.
	 *
	 * THE ORIGINAL'S VERSION OF THIS COULD NOT DO ITS FIRST TWO ADVERTISED JOBS. It declared overloads taking a
	 * `GeoPointInput` and an `H3Cell`, and then opened with `if (typeof input !== "string") throw` — so every call
	 * matching the coordinate-object overload threw a 400 before reaching the branch written to handle it. The H3 branch
	 * was reachable (an H3 cell is a string) but only after that guard, which is why the bug survived: the paths anyone
	 * exercised were the string ones. This version dispatches on the shape it was actually handed.
	 *
	 * A STRING IS NEVER READ AS A COORDINATE HERE, and that is a deliberate narrowing of the original. `"48.85, 2.29"` is
	 * ambiguous by construction: Google's own `latlng` parameter reads it as latitude-then-longitude, GeoJSON reads the
	 * same pair as longitude-then-latitude, and `GeoPoint.from` resolves the ambiguity as GeoJSON without a heuristic
	 * (#1487 removed the transposition repair on purpose). Accepting the string form would therefore reverse- geocode a
	 * point in Somalia for someone who typed Paris, confidently and for a fee. Callers holding a coordinate pass an
	 * object or a `GeoPoint`, where the axis order is stated rather than guessed.
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

		// `isGooglePlaceID` only checks the character class (`[A-Za-z0-9_-]+`), which a one-word place
		// name like "Paris" satisfies. A real Place ID is 27+ characters and always carries at least one
		// `_` or `-`; requiring both is what keeps an address out of the place-ID branch. Anything that
		// fails either test is free text, which is the safe default — a Place ID sent as an `address`
		// still geocodes, while an address sent as a `place_id` is an INVALID_REQUEST.
		if (trimmed.length >= GOOGLE_PLACE_ID_MIN_LENGTH && /[_-]/.test(trimmed) && isGooglePlaceID(trimmed)) {
			return this.geocodePlaceID(trimmed, options)
		}

		return this.geocodeAddress(trimmed, options)
	}

	/**
	 * Issue one geocode request, retrying Google's 200-wrapped transient statuses, and parse the results.
	 *
	 * THE RETRY LOOP HERE IS NOT REDUNDANT WITH `APIClient`'s. That one is driven off the HTTP layer — a status outside
	 * 2xx, or a transport failure — and `OVER_QUERY_LIMIT` is neither: it is a 200 with a JSON body, indistinguishable to
	 * every gate between the socket and this method. Teaching `core/api` to peek inside a body would make one API's
	 * in-band protocol the concern of every client in the repo, so the loop lives here, uses the same clock and the same
	 * policy numbers, and re-enters `fetch` (and therefore the pacer) on every attempt.
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
 * Create a Google Geocoding API client. See the file header for the full rationale.
 *
 * Throws immediately, before any request is made, when constructed without an explicit `apiKey` AND without
 * `GOOGLE_MAPS_API_KEY` set.
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
		// BOTH GATES, and the interval is the one that holds the rate. `requestsPerMinute` alone is a
		// BUDGET whose cooldown is `60000/N` minus the gap since the last dispatch, so N requests go out
		// back to back and the client then waits 60/N seconds — measured at 100/minute for a configured
		// 10/minute. See `bdc/sdk/client.ts`, where that measurement was taken, for the full trace.
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
			// Google sends its own `Cache-Control`. Honoring it would replace the reasoning behind
			// DEFAULT_CACHE_TTL_MS with whatever the CDN in front of maps.googleapis.com happens to say.
			interpretHeader: false,
			generateKey: geocodeCacheKey,
		},
		axios: {
			// THE KEY LIVES HERE, NOT IN THE URL. An instance-level `params` default is merged into every
			// request by Axios before the interceptor chain runs, so the key reaches the wire — while
			// `config.url`, which is what `APIClient` logs and what `delegateAxiosError` interpolates into
			// timeout/DNS messages, stays free of it.
			params: { key: apiKey },
			timeout: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
			responseType: "json",
			// `silentJSONParsing` defaults to TRUE, which hands back the RAW STRING when a body fails to
			// parse instead of raising. An HTML error page under a 200 would then be returned as a
			// `GoogleGeocodeResponse` and read as `status === undefined`; parse failures must be errors.
			transitional: { silentJSONParsing: false },
			...options.axios,
		},
	})
}
