/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file US Census Bureau geocoder client built on {@linkcode APIClient}.
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
 * Default request rate per minute.
 *
 * The Census Bureau publishes no rate limit for single-address requests,
 * so this value is a courtesy default.
 */
export const CENSUS_DEFAULT_REQUESTS_PER_MINUTE = 60

const MS_PER_MINUTE = 60_000

/**
 * Cache lifetime of one week, which bounds reuse across Census address-range refreshes.
 */
const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Maximum attempts for a transient failure, including the first attempt.
 */
const DEFAULT_MAX_ATTEMPTS = 3

/**
 * Base delay of the exponential retry backoff, in milliseconds.
 */
const DEFAULT_BASE_RETRY_DELAY_MS = 500

/**
 * Per-attempt timeout in milliseconds.
 *
 * Axios applies it to socket inactivity, so a slow but active response can take longer.
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
	 * Maximum requests per minute.
	 * Defaults to {@linkcode CENSUS_DEFAULT_REQUESTS_PER_MINUTE}.
	 */
	requestsPerMinute?: number
	/**
	 * Clock for pacing and retry delays.
	 * Tests inject a fake clock.
	 */
	clock?: ClockLike
	/**
	 * Cache directory.
	 * Defaults to `dataRootPath("geocode-oracle", "census")`.
	 */
	cacheDir?: PathBuilderLike
	/**
	 * Cache lifetime in milliseconds.
	 * Defaults to one week.
	 */
	cacheTTLMs?: number
	/**
	 * Maximum attempts for a transient failure.
	 * The client does not retry a 404 response.
	 */
	maxAttempts?: number
	/**
	 * Base delay of the exponential retry backoff, in milliseconds.
	 */
	baseRetryDelayMs?: number
	/**
	 * Per-attempt socket-inactivity timeout, in milliseconds.
	 */
	requestTimeoutMs?: number
	/**
	 * Axios options merged over the defaults.
	 * Tests inject an adapter here to avoid network calls.
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
	 * City name.
	 */
	city?: string
	/**
	 * Two-letter state abbreviation.
	 */
	state?: string
	/**
	 * Five-digit or ZIP+4 code.
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
 * Reports whether a response body is safe to cache.
 *
 * An empty `addressMatches` array is a cacheable no-match result.
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
	 * Returns all `locations/*` address matches, best first.
	 */
	public async lookupAddress(input: CensusGeocoderInput): Promise<OracleGeocodeResult<CensusAddressMatch>[]> {
		const { path, params } = buildQuery(input, "locations")

		params.benchmark = this.config.benchmark

		return this.#matches<CensusAddressMatch>(path, params)
	}

	/**
	 * Returns address matches with census geography layers.
	 *
	 * The benchmark and vintage must agree, so this method pins both to the 2020 census.
	 */
	public async lookupGeography(input: CensusGeocoderInput): Promise<OracleGeocodeResult<CensusGeographyMatch>[]> {
		const { path, params } = buildQuery(input, "geographies")

		params.benchmark = CensusBenchmarkName.Census2020
		params.vintage = CensusVintageName.Census2020

		return this.#matches<CensusGeographyMatch>(path, params)
	}

	/**
	 * Requests and parses matches.
	 *
	 * A no-match response throws a 404 error after the client caches the empty response.
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
 * Builds the endpoint path and query parameters for one-line or structured input.
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

	// The API treats an empty field as a filter, so blank fields are omitted.
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
 * Creates a configured US Census Bureau geocoder client.
 */
export function createCensusGeocoderClient(options: CreateCensusGeocoderClientOptions = {}): CensusGeocoderClient {
	const requestsPerMinute = Math.max(1, options.requestsPerMinute ?? CENSUS_DEFAULT_REQUESTS_PER_MINUTE)

	return new CensusGeocoderClient({
		displayName: "US Census Geocoder",
		benchmark: CensusBenchmarkName.Current,
		// The minimum interval spaces requests evenly.
		// The per-minute budget alone would allow bursts.
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
			// The configured TTL overrides any cache headers in the response.
			interpretHeader: false,
			cachePredicate: { statusCheck: (status) => status >= HTTP_OK && status < HTTP_MULTIPLE_CHOICES },
		},
		axios: {
			timeout: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
			responseType: "json",
			// A malformed or HTML body raises a parse error instead of passing through as a typed response.
			transitional: { silentJSONParsing: false },
			...options.axios,
		},
	})
}
