/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file US Census geocoder client built on {@linkcode APIClient} for pacing, caching, retries, and structured errors.
 *   The service is free and unauthenticated. It returns provider results only: no local PO Box shortcut is used.
 *   `vintage` applies only to `geographies/*`; geography benchmark and vintage are pinned together. Failures use
 *   {@linkcode ResourceError}, distinguishing no-match responses from transient service failures.
 */

import { APIClient, type APIClientConfig, type ClockLike } from "@mailwoman/core/api"
import { buildDiskStorage } from "@mailwoman/core/api/disk-storage"
import { dataRootPath } from "@mailwoman/core/data-root"
import { ResourceError } from "@mailwoman/core/errors"
import { stringifyJSON } from "@mailwoman/core/json"
import type { PathBuilderLike } from "path-ts"

import type { OracleGeocodeResult } from "#result"
import { parseCensusAddressMatch } from "#sdk/census/parser"
import {
	CensusBenchmarkName,
	type CensusAddressMatch,
	type CensusGeocodeResponse,
	type CensusGeographyMatch,
	CensusVintageName,
} from "#sdk/census/types"

/**
 * Base URL for Census geocoder endpoints.
 */
export const CENSUS_GEOCODER_BASE_URL = "https://geocoding.geo.census.gov/geocoder"

/**
 * Default request rate: 60 per minute.
 *
 * The Census Bureau publishes no rate limit for single-address requests;
 * this conservative default is for service courtesy.
 * Overload responses are retried.
 */
export const CENSUS_DEFAULT_REQUESTS_PER_MINUTE = 60

/**
 * Milliseconds per minute for rate-to-interval conversion.
 */
const MS_PER_MINUTE = 60_000

/**
 * Cache lifetime.
 *
 * Weekly caching limits reuse across the Census address-range data refreshes.
 */
const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Maximum attempts, including the first, for transient failures.
 */
const DEFAULT_MAX_ATTEMPTS = 3

/**
 * Base delay for the exponential backoff between retry attempts, in milliseconds.
 */
const DEFAULT_BASE_RETRY_DELAY_MS = 500

/**
 * Per-attempt inactivity timeout.
 *
 * Axios treats this as an idle-socket limit, not total request duration.
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
	 * Requests per minute this client will dispatch.
	 *
	 * Defaults to {@linkcode CENSUS_DEFAULT_REQUESTS_PER_MINUTE}.
	 */
	requestsPerMinute?: number
	/**
	 * Clock for pacing and retry delays; tests may inject a fake.
	 */
	clock?: ClockLike
	/**
	 * Cache directory.
	 * Defaults to `dataRootPath("geocode-oracle", "census")`.
	 */
	cacheDir?: PathBuilderLike
	/**
	 * How long a cached match stays fresh, in milliseconds.
	 *
	 * See {@linkcode DEFAULT_CACHE_TTL_MS}.
	 */
	cacheTTLMs?: number
	/**
	 * Maximum attempts for transient failures; 404 responses are not retried.
	 */
	maxAttempts?: number
	/**
	 * Base delay for the exponential backoff between retry attempts, in milliseconds.
	 */
	baseRetryDelayMs?: number
	/**
	 * Per-attempt socket-inactivity timeout, in milliseconds.
	 *
	 * See {@linkcode DEFAULT_REQUEST_TIMEOUT_MS}.
	 */
	requestTimeoutMs?: number
	/**
	 * Axios overrides merged over defaults.
	 * Tests inject an adapter to avoid network calls.
	 */
	axios?: APIClientConfig["axios"]
}

/**
 * Structured address accepted by the `locations/address` and `geographies/address` endpoints.
 */
export interface CensusAddressQuery {
	/**
	 * Street line, including house number.
	 */
	street?: string
	/**
	 * City, using the API's parameter name.
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
 * One-line or structured Census geocoder input.
 */
export type CensusGeocoderInput = string | CensusAddressQuery

/**
 * API client configuration plus Census-specific settings.
 */
export interface CensusGeocoderClientConfig extends APIClientConfig {
	/**
	 * Benchmark for `locations/*` lookups.
	 */
	benchmark: CensusBenchmarkName
}

/**
 * Validate the response envelope before caching.
 *
 * Empty `addressMatches` is a valid cacheable no-match result.
 */
export function isCacheableCensusBody(value: { data?: { data?: unknown } }): boolean {
	const body = value.data?.data as CensusGeocodeResponse | undefined

	return Boolean(body && typeof body === "object" && Array.isArray(body.result?.addressMatches))
}

/**
 * US Census Bureau geocoder client.
 */
export class CensusGeocoderClient extends APIClient<CensusGeocoderClientConfig> {
	/**
	 * Return all `locations/*` address matches, best first.
	 * Use `lookupGeography` for census geography data.
	 */
	public async lookupAddress(input: CensusGeocoderInput): Promise<OracleGeocodeResult<CensusAddressMatch>[]> {
		const { path, params } = buildQuery(input, "locations")

		params.benchmark = this.config.benchmark

		return this.#matches<CensusAddressMatch>(path, params)
	}

	/**
	 * Return address matches with geography layers.
	 * Pin the compatible 2020 benchmark and vintage together.
	 */
	public async lookupGeography(input: CensusGeocoderInput): Promise<OracleGeocodeResult<CensusGeographyMatch>[]> {
		const { path, params } = buildQuery(input, "geographies")

		params.benchmark = CensusBenchmarkName.Census2020
		params.vintage = CensusVintageName.Census2020

		return this.#matches<CensusGeographyMatch>(path, params)
	}

	/**
	 * Request and parse matches; throw a 404 for no-match responses.
	 * The empty response is cached before the error is raised.
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
				`The US Census geocoder returned no match for ${stringifyJSON(params)}. It covers the United States and ` +
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
 * Build endpoint path and parameters for one-line or structured input.
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

	// Omit empty fields; an empty state acts as a restrictive filter.
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
 * Create a configured US Census Bureau geocoder client.
 */
export function createCensusGeocoderClient(options: CreateCensusGeocoderClientOptions = {}): CensusGeocoderClient {
	const requestsPerMinute = Math.max(1, options.requestsPerMinute ?? CENSUS_DEFAULT_REQUESTS_PER_MINUTE)

	return new CensusGeocoderClient({
		displayName: "US Census Geocoder",
		benchmark: CensusBenchmarkName.Current,
		// The interval enforces pacing; the request budget alone permits bursts.
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
			// Use the configured TTL rather than a CDN cache header.
			interpretHeader: false,
			// Cache only successful responses.
			cachePredicate: { statusCheck: (status) => status >= HTTP_OK && status < HTTP_MULTIPLE_CHOICES },
		},
		axios: {
			timeout: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
			responseType: "json",
			// Raise parse errors rather than returning malformed or HTML bodies as typed responses.
			transitional: { silentJSONParsing: false },
			...options.axios,
		},
	})
}
