/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Fetches FCC CORES registration details by FRN to corroborate names and addresses.
 *   The client reads the HTML detail page on `apps.fcc.gov` because the documented JSON API on `data.fcc.gov`
 *   returns 403 to our host. The page lists registration details only, so it cannot support ownership edges.
 */

import {
	API_CLIENT_DEFAULTS,
	APIClient,
	assertAllowedHost,
	type APIClientConfig,
	type ClockLike,
} from "@mailwoman/core/api"
import { buildDiskStorage } from "@mailwoman/core/api/disk-storage"
import { dataRootPath } from "@mailwoman/core/data-root"

import { $private } from "#env"

/**
 * Default request rate.
 *
 * CORES publishes no rate limit, so the default is conservative.
 */
export const CORES_DEFAULT_REQUESTS_PER_SECOND = 4

/**
 * Upper bound on the request rate.
 * Higher requested rates are clamped to it.
 */
export const CORES_MAX_REQUESTS_PER_SECOND = 8

const MS_PER_SECOND = 1000

/**
 * Cache lifetime for registration pages, one week.
 */
const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

const HTTP_OK = 200
const HTTP_MULTIPLE_CHOICES = 300

const CORES_ALLOWED_HOSTS = new Set(["apps.fcc.gov"])

/**
 * Throws a non-retryable `request` error for a URL outside the CORES host allowlist.
 */
function assertCORESHost(url: URL): void {
	assertAllowedHost(url, {
		allowed: CORES_ALLOWED_HOSTS,
		scope: "createCORESClient",
		clientName: "cores",
		hostNote:
			"Note that data.fcc.gov is NOT on this list: its documented FRN JSON API 403s at the Akamai edge from the " +
			"lab host, which is why this client uses the apps.fcc.gov detail page instead.",
	})
}

export { parseCORESRegistration, recaseUniform, type CORESRegistration } from "#sdk/cores/registration"

export { coresDetailURL, fetchCORESRegistration, type CORESDocumentClient } from "#sdk/cores/document"

/**
 * Options for {@linkcode createCORESClient}.
 */
export interface CreateCORESClientOptions {
	/**
	 * User-Agent header.
	 *
	 * It falls back to `FCC_CORES_USER_AGENT`, then `SEC_EDGAR_USER_AGENT`, then a package default.
	 */
	userAgent?: string
	/**
	 * Requested rate, clamped to `[1, CORES_MAX_REQUESTS_PER_SECOND]`.
	 */
	requestsPerSecond?: number
	clock?: ClockLike
	/**
	 * Disk cache directory.
	 * The default is `fcc/cores/cache` under the data root.
	 */
	cacheDir?: string
	cacheTTLMs?: number
	maxAttempts?: number
	baseRetryDelayMs?: number
	requestTimeoutMs?: number
	/**
	 * Axios overrides.
	 * Passing `headers` replaces the default User-Agent header.
	 */
	axios?: APIClientConfig["axios"]
}

/**
 * Configuration for {@linkcode CORESClient}.
 */
export interface CORESClientConfig extends APIClientConfig {
	userAgent: string
}

/**
 * Returns whether a response body is a non-empty string.
 * An empty body may be a truncated response.
 */
function isCacheableCORESBody(value: { data?: { data?: unknown } }): boolean {
	const body = value.data?.data

	return typeof body === "string" && body.length > 0
}

/**
 * FCC CORES HTTP client.
 */
export class CORESClient extends APIClient<CORESClientConfig> {
	/**
	 * Fetches a URL on the allowed host and returns the raw HTML body.
	 */
	public async getDocument(input: string | URL): Promise<string> {
		const url = input instanceof URL ? input : new URL(input)

		assertCORESHost(url)

		const response = await this.fetch<string>({ url: url.toString(), responseType: "text" })

		return response.data
	}
}

/**
 * Creates an FCC CORES client with rate limiting, retries and a disk cache.
 */
export function createCORESClient(options: CreateCORESClientOptions = {}): CORESClient {
	const userAgent =
		options.userAgent ??
		$private.FCC_CORES_USER_AGENT ??
		$private.SEC_EDGAR_USER_AGENT ??
		"@mailwoman/filer (https://github.com/sister-software/mailwoman)"

	const requestsPerSecond = Math.max(
		1,
		Math.min(options.requestsPerSecond ?? CORES_DEFAULT_REQUESTS_PER_SECOND, CORES_MAX_REQUESTS_PER_SECOND)
	)

	return new CORESClient({
		displayName: "FCC CORES",
		userAgent,
		// Rounding up keeps the actual rate at or below the requested rate.
		minRequestIntervalMs: Math.ceil(MS_PER_SECOND / requestsPerSecond),
		retry: {
			maxAttempts: options.maxAttempts ?? API_CLIENT_DEFAULTS.maxAttempts,
			baseDelayMs: options.baseRetryDelayMs ?? API_CLIENT_DEFAULTS.baseRetryDelayMs,
		},
		clock: options.clock,
		caching: {
			storage: buildDiskStorage({
				directory: options.cacheDir ?? dataRootPath("fcc", "cores", "cache"),
				validate: isCacheableCORESBody,
			}),
			ttl: options.cacheTTLMs ?? DEFAULT_CACHE_TTL_MS,
			interpretHeader: false,
			cachePredicate: { statusCheck: (status) => status >= HTTP_OK && status < HTTP_MULTIPLE_CHOICES },
		},
		axios: {
			headers: {
				"User-Agent": userAgent,
				"Accept-Encoding": "gzip, deflate",
			},
			timeout: options.requestTimeoutMs ?? API_CLIENT_DEFAULTS.requestTimeoutMs,
			responseType: "text",
			...options.axios,
		},
	})
}
