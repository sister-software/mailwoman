/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Fetch FCC CORES registration details by FRN for independent name and address corroboration.
 *   The client uses the HTML detail page at `apps.fcc.gov`; the documented JSON endpoint returns 403 from
 *   the lab host. The page provides registration details, not parent or subsidiary relationships, so it must
 *   not be used to create ownership edges. Parsing uses the shared HTML text helper and preserves raw entity
 *   type values; parse failures abstain rather than fabricate records.
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

// Re-exported so callers can handle client errors from one import.

/**
 * Default request rate; CORES publishes no limit, so keep requests conservative.
 */
export const CORES_DEFAULT_REQUESTS_PER_SECOND = 4

/**
 * Maximum request rate, enforced even when a caller requests more.
 */
export const CORES_MAX_REQUESTS_PER_SECOND = 8

const MS_PER_SECOND = 1000

/**
 * Cache lifetime for registration records, which change when entities update their details.
 */
const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

const HTTP_OK = 200
const HTTP_MULTIPLE_CHOICES = 300

/**
 * Exact hostname allowed for CORES requests.
 */
const CORES_ALLOWED_HOSTS = new Set(["apps.fcc.gov"])

/**
 * Reject URLs outside the CORES host allowlist.
 *
 * @throws A {@linkcode ResourceError} whose URN kind is `request` — never transient,
 * since re-issuing the identical URL fails identically.
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
	 * Descriptive User-Agent sent with requests; defaults to configured FCC
	 * or SEC values, then a package fallback.
	 */
	userAgent?: string
	/**
	 * Requested rate, clamped to `[1, CORES_MAX_REQUESTS_PER_SECOND]`.
	 */
	requestsPerSecond?: number
	clock?: ClockLike
	/**
	 * On-disk cache directory; defaults under the FCC data root.
	 */
	cacheDir?: string
	cacheTTLMs?: number
	maxAttempts?: number
	baseRetryDelayMs?: number
	requestTimeoutMs?: number
	/**
	 * Axios overrides, including the adapter used by tests; replacing headers removes the default User-Agent.
	 */
	axios?: APIClientConfig["axios"]
}

export interface CORESClientConfig extends APIClientConfig {
	userAgent: string
}

/**
 * Cache only non-empty HTML response bodies; empty responses may be truncated.
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
	 * Fetch an absolute HTTPS URL on the allowed host and return its raw HTML body.
	 */
	public async getDocument(input: string | URL): Promise<string> {
		const url = input instanceof URL ? input : new URL(input)

		assertCORESHost(url)

		const response = await this.fetch<string>({ url: url.toString(), responseType: "text" })

		return response.data
	}
}

/**
 * Create an FCC CORES client with bounded pacing, retry, and disk caching.
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
		// Round up so fractional intervals cannot exceed the requested rate.
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
