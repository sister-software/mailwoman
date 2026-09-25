/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file FCC Broadband Data Collection (BDC) public-API client, built on {@linkcode APIClient}.
 *
 *   Requests fail with {@linkcode ResourceError}. Callers branch on the status and on
 *   `isTransientResourceError` as follows.
 *
 *   | Outcome                           | Caller action    | Test                                       |
 *   | --------------------------------- | ---------------- | ------------------------------------------ |
 *   | 401 / 403                         | abort the run    | `error.status === 401 \|\| === 403`         |
 *   | 404                               | skip this file   | `error.status === 404`                     |
 *   | exhausted 429/5xx                 | requeue          | `isTransientResourceError(error)`          |
 *   | exhausted network/timeout         | requeue          | `isTransientResourceError(error)`          |
 *   | undecodable body                  | programmer bug   | `isTransientResourceError(error)` is false |
 */

import { API_CLIENT_DEFAULTS, APIClient, type APIClientConfig, type ClockLike, systemClock } from "@mailwoman/core/api"
import { buildDiskStorage } from "@mailwoman/core/api/disk-storage"
import { dataRootPath } from "@mailwoman/core/data-root"
import { ResourceError } from "@mailwoman/core/errors"
import type { PathBuilderLike } from "path-ts"

import { $private } from "#env"

/**
 * Base URL for FCC BDC public API requests.
 */
export const BDC_API_BASE_URL = "https://broadbandmap.fcc.gov/api/public"

/**
 * Default requests per minute.
 *
 * The value comes from FCC documentation and has not been verified against the live API.
 */
export const BDC_DEFAULT_REQUESTS_PER_MINUTE = 10

const MS_PER_MINUTE = 60_000

const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const PERCENT = 100

/**
 * Default cache lifetime for BDC JSON responses.
 * Every JSON endpoint shares this lifetime.
 */
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Per-attempt idle-socket timeout for a zip download, in milliseconds.
 *
 * Axios applies `timeout` as an idle timer, so this limit catches a stalled transfer
 * without capping the total time of a large archive download.
 */
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 300_000

/**
 * Status that {@linkcode toArrayBuffer} reports for a non-binary body.
 *
 * The error has the `payload` kind, so `isTransientResourceError` treats it as terminal.
 */
const HTTP_INTERNAL_SERVER_ERROR = 500

/**
 * Statuses for rejected credentials, which {@linkcode explainCredentialFailure} rewrites.
 */
const HTTP_UNAUTHORIZED = 401
const HTTP_FORBIDDEN = 403

/**
 * Options for {@linkcode createBDCClient}.
 */
export interface CreateBDCClientOptions {
	/**
	 * FCC Broadband Map username.
	 * Defaults to `$private.FCC_MAP_USERNAME`.
	 */
	username?: string
	/**
	 * FCC Broadband Map API key, sent as the `hash_value` header.
	 * Defaults to `$private.FCC_MAP_API_KEY`.
	 */
	apiKey?: string
	/**
	 * Requests per minute.
	 *
	 * Defaults to {@linkcode BDC_DEFAULT_REQUESTS_PER_MINUTE}, and values below 1 become 1.
	 */
	requestsPerMinute?: number
	/**
	 * Time source for the throttle, the cooldown timer and the retry backoff.
	 * Defaults to the system clock.
	 *
	 * Tests pass a fake clock so that they never sleep in real time.
	 */
	clock?: ClockLike
	/**
	 * On-disk cache root.
	 *
	 * Defaults to `dataRootPath("bdc", "cache", "http")`, resolved at construction.
	 */
	cacheDir?: PathBuilderLike
	/**
	 * How long a cached JSON response stays fresh, in milliseconds.
	 */
	cacheTTLMs?: number
	/**
	 * Total attempts, including the first, for a 429, 5xx or network failure.
	 *
	 * A 401, 403 or 404 is never retried.
	 */
	maxAttempts?: number
	/**
	 * Base delay for exponential retry backoff, in milliseconds.
	 *
	 * Attempt `n` waits `baseRetryDelayMs * 2^(n-1)`.
	 * A `Retry-After` header takes precedence.
	 */
	baseRetryDelayMs?: number
	/**
	 * Per-attempt idle-socket timeout for a JSON request, in milliseconds.
	 */
	requestTimeoutMs?: number
	/**
	 * Per-attempt idle-socket timeout for a zip download, in milliseconds.
	 */
	downloadTimeoutMs?: number
	/**
	 * Axios overrides, merged over this client's defaults.
	 * Tests pass an `adapter` here.
	 *
	 * Replacing `headers` would drop the credential headers.
	 */
	axios?: APIClientConfig["axios"]
}

/**
 * Query-string parameters for {@linkcode BDCClient.get}.
 * An `undefined` value is omitted.
 */
export type BDCQueryParams = Record<string, string | number | undefined>

/**
 * Per-call overrides for {@linkcode BDCClient.get}.
 */
export interface BDCGetOptions {
	/**
	 * Skip both the cache read and the cache write for this call.
	 * The throttle still applies.
	 */
	skipCache?: boolean
}

/**
 * Time a run spent waiting on the request throttle, from {@linkcode BDCClient.throttleStats}.
 */
export interface BDCThrottleStats {
	/**
	 * Milliseconds since the client was constructed, on the client's clock.
	 */
	elapsedMs: number
	/**
	 * Wall-clock milliseconds during which at least one request was sleeping.
	 *
	 * Retry backoff is included because `APIClient` does not expose a way to separate it.
	 */
	waitingMs: number
	/**
	 * Number of separate sleeps that make up {@linkcode BDCThrottleStats.waitingMs}.
	 */
	waits: number
	/**
	 * Number of `cooldown_start` events from the per-minute budget.
	 *
	 * Each cooldown is a real wait.
	 * At 10 requests per minute it adds about 6 seconds per 10 requests.
	 */
	cooldowns: number
}

/**
 * {@linkcode APIClient} configuration plus the fields that {@linkcode BDCClient} reads.
 */
export interface BDCClientConfig extends APIClientConfig {
	/**
	 * The account username, shown in credential errors.
	 * The API key is never shown.
	 */
	username: string
	/**
	 * Idle-socket timeout for binary downloads.
	 * JSON requests use `axios.timeout`.
	 */
	downloadTimeoutMs: number
	/**
	 * Returns a snapshot of the throttle meter that {@linkcode createBDCClient} installs.
	 */
	readThrottleStats: () => BDCThrottleStats
}

/**
 * Request config accepted by {@linkcode APIClient.fetch}.
 * This package reaches Axios only through `@mailwoman/core`.
 */
type BDCRequestConfig = Parameters<APIClient["fetch"]>[0]

/**
 * Request config with the cache interceptor's per-request `cache` switch.
 *
 * `APIClient.fetch` does not declare `cache`, so this intersection lets the field typecheck.
 * With `cache: false`, the interceptor skips both the cache read and the cache write.
 */
type UncachedBDCRequestConfig = BDCRequestConfig & {
	cache: false
}

/**
 * Build the absolute request URL for `path`, with `params` as its query string.
 *
 * `path` is concatenated onto {@linkcode BDC_API_BASE_URL}.
 * Resolving it with `new URL(path, base)` would let an absolute `path` send
 * the credential headers to another host.
 */
function buildBDCURL(path: string, params: BDCQueryParams = {}): URL {
	const url = new URL(`${BDC_API_BASE_URL}${path}`)

	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) {
			url.searchParams.set(key, String(value))
		}
	}

	return url
}

/**
 * Rewrite a 401 or 403 into an error that explains the credential rejection.
 *
 * The rewritten error keeps the same status.
 * Any other error is returned unchanged.
 */
function explainCredentialFailure(error: unknown, url: URL, username: string): unknown {
	if (!(error instanceof ResourceError)) return error

	if (error.status !== HTTP_UNAUTHORIZED && error.status !== HTTP_FORBIDDEN) return error

	const explained = ResourceError.from(
		error.status,
		`FCC BDC request failed: ${error.status} (${url}). The BDC public API rejected the credential pair, which it ` +
			`takes as the plain \`username\` + \`hash_value\` request headers (NOT bearer or basic auth). The configured ` +
			`username was "${username}"; check it and \`FCC_MAP_API_KEY\` against the account registered at ` +
			`https://broadbandmap.fcc.gov. This is not retried — retrying a rejected credential cannot succeed, and at ` +
			`10 requests/minute it would burn six seconds per attempt.`,
		"axios",
		"response",
		error.status === HTTP_UNAUTHORIZED ? "unauthorized" : "forbidden"
	)

	explained.cause = error

	return explained
}

/**
 * Coerce a binary response body into an `ArrayBuffer`.
 *
 * Axios's Node adapter returns a `Buffer`, and its fetch adapter returns an `ArrayBuffer`.
 * A view that spans its whole backing buffer is returned without copying,
 * which matters for archives of hundreds of megabytes.
 */
function toArrayBuffer(data: unknown): ArrayBuffer {
	if (data instanceof ArrayBuffer) return data

	if (ArrayBuffer.isView(data)) {
		const { buffer, byteOffset, byteLength } = data

		if (byteOffset === 0 && byteLength === buffer.byteLength) return buffer as ArrayBuffer

		return buffer.slice(byteOffset, byteOffset + byteLength) as ArrayBuffer
	}

	throw ResourceError.from(
		HTTP_INTERNAL_SERVER_ERROR,
		`FCC BDC download returned a ${typeof data} body where binary bytes were expected. This is a client ` +
			'misconfiguration (the request must carry `responseType: "arraybuffer"`) rather than an upstream failure.',
		"axios",
		"payload",
		"not-binary"
	)
}

/**
 * FCC BDC public-API client.
 * Build one with {@linkcode createBDCClient}.
 */
export class BDCClient extends APIClient<BDCClientConfig> {
	/**
	 * Issue an authenticated `GET` and return the parsed JSON body, using the cache, throttle and retry.
	 *
	 * `path` starts with a slash, as in `/map/listAsOfDates`, and `params` become the query string.
	 * The body is returned whole, so callers read its `data` field themselves.
	 * Concurrent cache misses for the same URL share one request.
	 */
	public async get<T>(path: string, params?: BDCQueryParams, options: BDCGetOptions = {}): Promise<T> {
		const url = buildBDCURL(path, params)

		const config: UncachedBDCRequestConfig | BDCRequestConfig = options.skipCache
			? { url: url.toString(), cache: false }
			: { url: url.toString() }

		return this.#request<T>(config, url)
	}

	/**
	 * Issue an authenticated `GET` and return the body as an `ArrayBuffer`, for zip downloads.
	 *
	 * This path never uses the response cache, which stores only JSON envelopes.
	 * `downloadBDCFile` keeps its own copy on disk.
	 * The throttle still applies.
	 */
	public async getArrayBuffer(path: string, params?: BDCQueryParams): Promise<ArrayBuffer> {
		const url = buildBDCURL(path, params)

		const config: UncachedBDCRequestConfig = {
			url: url.toString(),
			responseType: "arraybuffer",
			timeout: this.config.downloadTimeoutMs,
			cache: false,
		}

		return toArrayBuffer(await this.#request<unknown>(config, url))
	}

	/**
	 * Time this client has spent waiting on the throttle so far.
	 *
	 * {@linkcode formatBDCThrottleStats} renders it as one line.
	 */
	public throttleStats(): BDCThrottleStats {
		return this.config.readThrottleStats()
	}

	/**
	 * Issue one request and return its body, rewriting a credential rejection.
	 */
	async #request<T>(config: BDCRequestConfig, url: URL): Promise<T> {
		try {
			const response = await this.fetch<T>(config)

			return response.data
		} catch (error) {
			throw explainCredentialFailure(error, url, this.config.username)
		}
	}
}

/**
 * Render {@linkcode BDCThrottleStats} as one human-readable line, for the end of an ingestion run.
 */
export function formatBDCThrottleStats(stats: BDCThrottleStats): string {
	const share = stats.elapsedMs > 0 ? Math.round((stats.waitingMs / stats.elapsedMs) * PERCENT) : 0

	return (
		`elapsed ${formatDuration(stats.elapsedMs)} · ${formatDuration(stats.waitingMs)} (${share}%) spent waiting on ` +
		`the request throttle across ${stats.waits} wait(s) and ${stats.cooldowns} budget cooldown(s)`
	)
}

/**
 * Format milliseconds as whole minutes and seconds, for example `123456` as `"2m 3s"`.
 */
function formatDuration(ms: number): string {
	const totalSeconds = Math.round(ms / MS_PER_SECOND)
	const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE)
	const seconds = totalSeconds % SECONDS_PER_MINUTE

	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

/**
 * Wrap a {@linkcode ClockLike} so that it records how long the client sleeps.
 *
 * Every `APIClient` wait sleeps on the clock, so the wrapper sees throttle, cooldown and retry waits.
 * Concurrent sleeps overlap, so the meter counts the wall-clock time during
 * which at least one sleep is pending.
 *
 * Summing each sleep would report more waiting than elapsed time.
 */
function createMeteredClock(base: ClockLike): {
	clock: ClockLike
	read: (cooldowns: number) => BDCThrottleStats
} {
	const startedAt = base.now()
	let waitingMs = 0
	let waits = 0
	let inFlight = 0
	let blockedSince = 0

	return {
		clock: {
			now: () => base.now(),
			sleep: async (ms: number) => {
				// `setCooldown` issues a zero-length sleep on each budget rollover.
				// It is a yield and does not count.
				if (ms <= 0) return base.sleep(ms)

				if (inFlight === 0) {
					blockedSince = base.now()
				}

				inFlight += 1
				waits += 1

				try {
					await base.sleep(ms)
				} finally {
					inFlight -= 1

					if (inFlight === 0) {
						waitingMs += Math.max(base.now() - blockedSince, 0)
					}
				}
			},
		},
		read: (cooldowns: number) => ({
			elapsedMs: base.now() - startedAt,
			waitingMs,
			waits,
			cooldowns,
		}),
	}
}

/**
 * Create an FCC Broadband Data Collection public-API client.
 *
 * @throws When no credentials are passed and `FCC_MAP_USERNAME` or `FCC_MAP_API_KEY` is unset.
 */
export function createBDCClient(options: CreateBDCClientOptions = {}): BDCClient {
	const username = options.username ?? $private.FCC_MAP_USERNAME
	const apiKey = options.apiKey ?? $private.FCC_MAP_API_KEY

	if (!username || !apiKey) {
		throw new Error(
			"createBDCClient: missing FCC Broadband Map credentials. Pass `username`/`apiKey` explicitly, or set the " +
				"`FCC_MAP_USERNAME`/`FCC_MAP_API_KEY` environment variables (register at https://broadbandmap.fcc.gov " +
				"to obtain them)."
		)
	}

	const requestsPerMinute = Math.max(1, options.requestsPerMinute ?? BDC_DEFAULT_REQUESTS_PER_MINUTE)
	const meter = createMeteredClock(options.clock ?? systemClock)

	let cooldowns = 0

	const client = new BDCClient({
		displayName: "FCC BDC",
		username,
		downloadTimeoutMs: options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
		readThrottleStats: () => meter.read(cooldowns),
		// `APIClient` treats `requestsPerMinute` as a burst budget, so on its own
		// it lets N requests out back to back.
		// `minRequestIntervalMs` spaces the requests and holds the real rate.
		// Together they add a short cooldown after every N requests, which gives about
		// 9.1 requests per minute at a limit of 10.
		requestsPerMinute,
		minRequestIntervalMs: Math.ceil(MS_PER_MINUTE / requestsPerMinute),
		retry: {
			maxAttempts: options.maxAttempts ?? API_CLIENT_DEFAULTS.maxAttempts,
			baseDelayMs: options.baseRetryDelayMs ?? API_CLIENT_DEFAULTS.baseRetryDelayMs,
		},
		clock: meter.clock,
		caching: {
			storage: buildDiskStorage({
				directory: options.cacheDir ?? dataRootPath("bdc", "cache", "http"),
				// Only a `data`-keyed envelope is cached.
				// Anything else is an error page or a redirect.
				validate: (value) => isBDCEnvelope(value.data?.data),
			}),
			ttl: options.cacheTTLMs ?? DEFAULT_CACHE_TTL_MS,
			// The CDN's cache headers must not override the TTL above.
			interpretHeader: false,
			// A `cachePredicate` is unnecessary.
			// Axios rejects non-2xx responses before the cache interceptor sees them,
			// so failures are never cached.
		},
		axios: {
			headers: {
				// The BDC API reads credentials from two plain headers instead of an Authorization header.
				username,
				hash_value: apiKey,
			},
			timeout: options.requestTimeoutMs ?? API_CLIENT_DEFAULTS.requestTimeoutMs,
			responseType: "json",
			// By default Axios returns the raw string when JSON parsing fails.
			// This setting makes it throw.
			transitional: { silentJSONParsing: false },
			...options.axios,
		},
	})

	client.addEventListener("cooldown_start", () => {
		cooldowns++

		client.logger.debug("Per-minute request budget spent — waiting for the cooldown to lapse.")
	})

	client.addEventListener("cooldown_end", () => {
		client.logger.debug("Request budget cooldown lapsed.")
	})

	return client
}

/**
 * Whether a decoded response body is the `{ data: … }` envelope that BDC endpoints return.
 */
function isBDCEnvelope(body: unknown): boolean {
	return typeof body === "object" && body !== null && "data" in body
}
