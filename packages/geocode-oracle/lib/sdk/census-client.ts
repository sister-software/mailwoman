/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file US Census Bureau geocoder client, built on {@linkcode APIClient}. Ported from
 *   `isp-nexus/universe/mailwoman/sdk/census/index.ts`, which was a bare `Axios.create({ baseURL,
 *   timeout: 5000 })` with no pacing, no cache, no retry, and a bespoke `CensusGeocoderError` that
 *   carried no status — so a caller could only tell "no match here" from "the service is down" by
 *   reading message prose. All four now come from `@mailwoman/core/api`.
 *
 *   NO CREDENTIAL. The Census geocoder is free and unauthenticated, which makes this the simplest
 *   client in the repo and removes the fail-fast constructor check `sec-client.ts` and
 *   `bdc/sdk/client.ts` both open with.
 *
 *   TWO DIVERGENCES FROM THE ORIGINAL that change behaviour, both deliberate:
 *
 *     1. **The PO Box shortcut is gone.** `lookupAddress` opened by sanitizing its input and, if the
 *        result started with `PO BOX`, RETURNING A LOCALLY-PARSED ADDRESS WITHOUT ISSUING A REQUEST —
 *        so one branch of a method named "lookup" answered from a local parser and produced a record
 *        with no coordinate, silently, under the same return type. That is a reasonable shortcut in a
 *        pipeline that just needs an address record; it is disqualifying in an ORACLE, whose entire
 *        contract is "this is what the provider said". A PO Box the Census geocoder cannot match now
 *        raises the same 404 as any other unmatched address.
 *     2. **`vintage` is no longer sent to the `locations/*` endpoints.** It is a `geographies/*`
 *        parameter only; the original sent it on every call. Harmless in practice (the API ignores it)
 *        and wrong to keep, because it implied the two knobs were independent when the API requires
 *        them to agree — see {@linkcode CensusVintageName}.
 *
 *   ERROR CONTRACT. Every failure is a {@linkcode ResourceError}, so a sweep branches on `status` plus
 *   {@linkcode isTransientResourceError} and never on message prose:
 *
 *   | Outcome                                   | Caller action     | Test                              |
 *   | ----------------------------------------- | ----------------- | --------------------------------- |
 *   | no `addressMatches`                       | no match, move on | `error.status === 404`            |
 *   | exhausted 429/5xx, network, timeout       | requeue           | `isTransientResourceError(error)` |
 *   | undecodable body                          | programmer bug    | `isTransientResourceError(error)` is false |
 */

import { APIClient, type APIClientConfig, type ClockLike } from "@mailwoman/core/api"
import { buildDiskStorage } from "@mailwoman/core/api/disk-storage"
import { dataRootPath } from "@mailwoman/core/data-root"
import { ResourceError } from "@mailwoman/core/errors"

import type { OracleGeocodeResult } from "#result"
import { parseCensusAddressMatch } from "#sdk/census-parser"
import {
	CensusBenchmarkName,
	type CensusAddressMatch,
	type CensusGeocodeResponse,
	type CensusGeographyMatch,
	CensusVintageName,
} from "#sdk/census-types"

/**
 * The geocoder's base URL. Every path below is appended to it.
 */
export const CENSUS_GEOCODER_BASE_URL = "https://geocoding.geo.census.gov/geocoder"

/**
 * What this client paces at by default: **60 requests per minute**, one per second.
 *
 * SOURCING, stated precisely because it could not be verified: the Census Bureau publishes NO rate limit for the
 * single-address geocoding endpoints. It does cap the separate BATCH endpoint at 10,000 records per submission, which
 * is a size limit rather than a rate. So this number is a politeness posture toward a free public service, not a
 * published ceiling — the same footing `BDC_DEFAULT_REQUESTS_PER_MINUTE` is on, and for the same reason it is a DEFAULT
 * rather than a clamp.
 *
 * The service is also genuinely slow (multi-second responses are routine under load) and answers with a 500 when
 * overwhelmed, which the retry policy below treats as transient.
 */
export const CENSUS_DEFAULT_REQUESTS_PER_MINUTE = 60

/**
 * Milliseconds in a minute — the numerator when turning a requests/minute budget into a pacing interval.
 */
const MS_PER_MINUTE = 60_000

/**
 * How long a cached match stays fresh: **7 days**.
 *
 * Shorter than the Google client's thirty because the answer is versioned rather than stable. `Public_AR_Current` is
 * re-cut from MTDB twice a year, and a re-cut can move an interpolated coordinate along its segment or reassign the
 * segment entirely. A week bounds how long a run can be reading pre-roll answers, and costs nothing — the requests are
 * free, and the cache exists here to spare a slow public service, not a bill.
 */
const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Total attempts (including the first) before giving up on a 429/5xx or a network-class failure.
 */
const DEFAULT_MAX_ATTEMPTS = 3

/**
 * Base delay for the exponential backoff between retry attempts, in milliseconds.
 */
const DEFAULT_BASE_RETRY_DELAY_MS = 500

/**
 * Per-attempt socket-inactivity timeout, in milliseconds.
 *
 * DELIBERATELY SIX TIMES THE isp-nexus ORIGINAL'S 5,000. That client timed out at five seconds against a service whose
 * responses routinely take longer than that under load — so a busy afternoon read as a hard failure. Axios applies
 * `timeout` as an idle-socket timer rather than a total-elapsed budget, so a larger value bounds "the transfer stalled"
 * without capping a slow-but-healthy response.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

const HTTP_BAD_REQUEST = 400
const HTTP_NOT_FOUND = 404
const HTTP_OK = 200
const HTTP_MULTIPLE_CHOICES = 300

/**
 * Options for {@linkcode createCensusGeocoderClient}.
 */
export interface CreateCensusGeocoderClientOptions {
	/**
	 * Requests per minute this client will dispatch. Defaults to {@linkcode CENSUS_DEFAULT_REQUESTS_PER_MINUTE}.
	 */
	requestsPerMinute?: number
	/**
	 * Time source powering the pacer, the cooldown timer, and the retry backoff. Defaults to the system clock; tests
	 * inject a fake one so no suite sleeps on the wall clock.
	 */
	clock?: ClockLike
	/**
	 * On-disk cache root. Defaults to `dataRootPath("geocode-oracle", "census")`, resolved once at construction.
	 */
	cacheDir?: string
	/**
	 * How long a cached match stays fresh, in milliseconds. See {@linkcode DEFAULT_CACHE_TTL_MS}.
	 */
	cacheTTLMs?: number
	/**
	 * Total attempts (including the first) before giving up on a transient failure. Never applies to a 404.
	 */
	maxAttempts?: number
	/**
	 * Base delay for the exponential backoff between retry attempts, in milliseconds.
	 */
	baseRetryDelayMs?: number
	/**
	 * Per-attempt socket-inactivity timeout, in milliseconds. See {@linkcode DEFAULT_REQUEST_TIMEOUT_MS}.
	 */
	requestTimeoutMs?: number
	/**
	 * Axios overrides, merged over this client's own defaults. THE TEST SEAM: every test passes an `adapter` here, so no
	 * test in this workspace performs a live network call.
	 */
	axios?: APIClientConfig["axios"]
}

/**
 * A structured address, as the `locations/address` and `geographies/address` endpoints take it. Every field is
 * optional; the geocoder matches on whatever it is given, and more fields is a narrower search.
 */
export interface CensusAddressQuery {
	/**
	 * The street line INCLUDING the house number — `"4600 Silver Hill Rd"`.
	 */
	street?: string
	/**
	 * The city. Named `city` rather than `locality` because it is the API's own parameter name.
	 */
	city?: string
	/**
	 * The two-letter state abbreviation.
	 */
	state?: string
	/**
	 * The ZIP code, five-digit or plus-four.
	 */
	zip?: string
}

/**
 * A Census geocoder input: a one-line address string, or the structured form.
 */
export type CensusGeocoderInput = string | CensusAddressQuery

/**
 * {@linkcode APIClient} configuration plus the fields {@linkcode CensusGeocoderClient} reads back off `config`.
 */
export interface CensusGeocoderClientConfig extends APIClientConfig {
	/**
	 * The benchmark every `locations/*` lookup pins.
	 */
	benchmark: CensusBenchmarkName
}

/**
 * Whether a decoded body is the `{ result: { addressMatches: [...] } }` envelope this API answers with.
 *
 * VALIDATED BEFORE WRITING, per `core/api/disk-storage.ts`'s first rule. The Census geocoder answers an overload with
 * an HTML error page, and — because Axios's `transitional.silentJSONParsing` is turned off below — that already raises
 * rather than being handed back as a string. This is the second gate: a 200 whose JSON is structurally something else
 * must not reach disk under a week-long TTL.
 *
 * An EMPTY `addressMatches` array is cacheable. "This address does not match TIGER" is a real, stable answer, and it is
 * the answer for a large share of the rural and PO-Box inputs an oracle sweep will hand it.
 */
export function isCacheableCensusBody(value: { data?: { data?: unknown } }): boolean {
	const body = value.data?.data as CensusGeocodeResponse | undefined

	return Boolean(body && typeof body === "object" && Array.isArray(body.result?.addressMatches))
}

/**
 * A US Census Bureau geocoder client. Build one with {@linkcode createCensusGeocoderClient}.
 */
export class CensusGeocoderClient extends APIClient<CensusGeocoderClientConfig> {
	/**
	 * Geocode an address and return every TIGER match, best first.
	 *
	 * `locations/*` — the address + coordinate only. Use {@linkcode CensusGeocoderClient.lookupGeography} when the census
	 * block/tract attributes are wanted too; it is a different endpoint, not a flag on this one.
	 */
	public async lookupAddress(input: CensusGeocoderInput): Promise<OracleGeocodeResult<CensusAddressMatch>[]> {
		const { path, params } = buildQuery(input, "locations")

		params.benchmark = this.config.benchmark

		return this.#matches<CensusAddressMatch>(path, params)
	}

	/**
	 * Geocode an address AND attach the census geography layers the match falls in — the `geographies.Census Blocks`
	 * entry carries the 2020 block GEOID, population and housing counts.
	 *
	 * Pins the Census 2020 benchmark/vintage PAIR. The two must agree (see {@linkcode CensusVintageName}), so they are
	 * pinned together here rather than exposed as two knobs a caller can put out of step.
	 */
	public async lookupGeography(input: CensusGeocoderInput): Promise<OracleGeocodeResult<CensusGeographyMatch>[]> {
		const { path, params } = buildQuery(input, "geographies")

		params.benchmark = CensusBenchmarkName.Census2020
		params.vintage = CensusVintageName.Census2020

		return this.#matches<CensusGeographyMatch>(path, params)
	}

	/**
	 * Issue one lookup and parse its matches, raising a 404 when there are none.
	 *
	 * A NO-MATCH IS AN ERROR HERE, not an empty array, and the choice is deliberate: it makes "the address did not
	 * geocode" land on the same `error.status` branch a caller already writes for every other client in this repo, rather
	 * than as a second success shape only this one has. The empty response is still CACHED (see
	 * {@linkcode isCacheableCensusBody}) — the error is raised after the interceptor has persisted the body, so a repeat
	 * of an unmatched address costs no request.
	 */
	async #matches<Match extends CensusAddressMatch>(
		path: string,
		params: Record<string, string>
	): Promise<OracleGeocodeResult<Match>[]> {
		const response = await this.fetch<CensusGeocodeResponse<Match>>({
			url: `${CENSUS_GEOCODER_BASE_URL}${path}`,
			params: { ...params, format: "json" },
		})

		const matches = response.data.result?.addressMatches ?? []

		if (!matches.length) {
			throw ResourceError.from(
				HTTP_NOT_FOUND,
				`The US Census geocoder returned no match for ${JSON.stringify(params)}. It covers the United States and ` +
					"its territories only, geocodes against TIGER address RANGES (so a genuinely new or rural address can " +
					"be absent from an otherwise-correct street), and does not match PO Boxes at all.",
				"census",
				"response",
				"no-match"
			)
		}

		return matches.map((match) => parseCensusAddressMatch(match))
	}
}

/**
 * Turn an input into its endpoint path and query parameters.
 *
 * The one-line and structured forms are DIFFERENT ENDPOINTS (`…/onelineaddress` vs `…/address`), not two ways of
 * filling one — which is why this returns the path alongside the parameters instead of leaving the caller to pair
 * them.
 */
function buildQuery(
	input: CensusGeocoderInput,
	family: "locations" | "geographies"
): { path: string; params: Record<string, string> } {
	if (typeof input === "string") {
		const address = input.trim()

		if (!address) {
			throw ResourceError.from(
				HTTP_BAD_REQUEST,
				"The US Census geocoder was given an empty address.",
				"census",
				"request",
				"empty-address"
			)
		}

		return { path: `/${family}/onelineaddress`, params: { address } }
	}

	const params: Record<string, string> = {}

	// Omitted rather than serialized as the literal string "undefined" — the geocoder treats an empty
	// `state` as a filter that nothing matches, so sending one is worse than sending none.
	for (const [name, value] of Object.entries(input)) {
		if (value !== undefined && value !== null && String(value).trim()) {
			params[name] = String(value).trim()
		}
	}

	if (!Object.keys(params).length) {
		throw ResourceError.from(
			HTTP_BAD_REQUEST,
			"The US Census geocoder was given a structured address with no populated fields.",
			"census",
			"request",
			"empty-address"
		)
	}

	return { path: `/${family}/address`, params }
}

/**
 * Create a US Census Bureau geocoder client. See the file header for the full rationale.
 */
export function createCensusGeocoderClient(options: CreateCensusGeocoderClientOptions = {}): CensusGeocoderClient {
	const requestsPerMinute = Math.max(1, options.requestsPerMinute ?? CENSUS_DEFAULT_REQUESTS_PER_MINUTE)

	return new CensusGeocoderClient({
		displayName: "US Census Geocoder",
		benchmark: CensusBenchmarkName.Current,
		// BOTH GATES, and the interval is the one that holds the rate — `requestsPerMinute` alone is a
		// budget that dispatches N back to back and then waits 60/N seconds, measured at 100/minute for a
		// configured 10/minute. See `bdc/sdk/client.ts` for the full arrival trace.
		requestsPerMinute,
		minRequestIntervalMs: Math.ceil(MS_PER_MINUTE / requestsPerMinute),
		retry: {
			maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
			baseDelayMs: options.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS,
		},
		clock: options.clock,
		caching: {
			storage: buildDiskStorage({
				directory: options.cacheDir ?? dataRootPath("geocode-oracle", "census"),
				validate: isCacheableCensusBody,
			}),
			ttl: options.cacheTTLMs ?? DEFAULT_CACHE_TTL_MS,
			// The TTL above is chosen against the twice-yearly MTDB re-cut. Letting a response header
			// override it would replace that reasoning with whatever the CDN happens to send.
			interpretHeader: false,
			// Never cache a failure: the interceptor's default predicate admits 3xx too.
			cachePredicate: { statusCheck: (status) => status >= HTTP_OK && status < HTTP_MULTIPLE_CHOICES },
		},
		axios: {
			timeout: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
			responseType: "json",
			// `silentJSONParsing` defaults to TRUE, which hands back the RAW STRING when a body fails to
			// parse. The Census geocoder answers an overload with an HTML error page under a 200; returning
			// that as a `CensusGeocodeResponse` would surface as `result` being undefined at the call site
			// rather than as an error, so parse failures must raise.
			transitional: { silentJSONParsing: false },
			...options.axios,
		},
	})
}
