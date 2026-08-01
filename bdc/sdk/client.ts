/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file FCC Broadband Data Collection (BDC) public-API client, built on {@linkcode APIClient}.
 *
 *   Originally re-homed from Nexus's `sync/fcc/bdc/client.ts` (relicense-by-copy, no provenance
 *   headers) as a raw-`fetch` factory. That version had no throttle, no cache and no retry at all, and
 *   threw a bespoke `Error` a caller could only branch on by reading its prose. All four now come from
 *   `@mailwoman/core/api`, the repo's default base for HTTP clients (see `AGENTS.md`).
 *   `filer/sdk/sec-client.ts` is the worked example this follows. What stays BDC-specific:
 *
 *     1. The credential fail-fast off `$private.FCC_MAP_USERNAME`/`FCC_MAP_API_KEY`. A
 *        silently-unauthenticated client just 401s on first use, which is a worse failure mode than
 *        failing at construction.
 *     2. The `username` + `hash_value` PLAIN HEADER PAIR — read carefully off the Nexus original's
 *        `axios.headers` config, this is NOT bearer or basic auth.
 *     3. The request budget: {@linkcode BDC_DEFAULT_REQUESTS_PER_MINUTE} requests per MINUTE, six
 *        seconds apart. See that constant for the sourcing and for why the interval gate is set too.
 *     4. UN-UNWRAPPED response bodies. Every BDC endpoint nests its payload under a `data` key
 *        (`{ data: [...] }`), and callers pluck `.data` themselves at the call site — `filing-dates.ts`
 *        and `list-files.ts` both do. {@linkcode BDCClient.get} deliberately does NOT unwrap, so the
 *        envelope stays visible in the caller's own response type.
 *     5. The zip path ({@linkcode BDCClient.getArrayBuffer}), which is binary and UNCACHED. See its
 *        docstring.
 *
 *   ERROR CONTRACT. Every failure past construction is a {@linkcode ResourceError}, so an ingestion run
 *   branches on `status` plus {@linkcode isTransientResourceError} and never on message prose:
 *
 *   | Outcome                           | Caller action    | Test                                       |
 *   | --------------------------------- | ---------------- | ------------------------------------------ |
 *   | 401 / 403                         | abort the run    | `error.status === 401 \|\| === 403`         |
 *   | 404                               | skip this file   | `error.status === 404`                     |
 *   | exhausted 429/5xx                 | requeue          | `isTransientResourceError(error)`          |
 *   | exhausted network/timeout         | requeue          | `isTransientResourceError(error)`          |
 *   | undecodable body                  | programmer bug   | `isTransientResourceError(error)` is false |
 */

import { APIClient, type APIClientConfig, type ClockLike, systemClock } from "@mailwoman/core/api"
import { buildDiskStorage } from "@mailwoman/core/api/disk-storage"
import { $private } from "@mailwoman/core/env"
import { ResourceError } from "@mailwoman/core/errors"
import { dataRootPath } from "@mailwoman/core/utils"

// Re-exported so a caller branching on this client's failures needs exactly one import.
export { isTransientResourceError } from "@mailwoman/core/api"
export { ResourceError } from "@mailwoman/core/errors"

/**
 * The FCC BDC public-API base URL every request is resolved against.
 */
export const BDC_API_BASE_URL = "https://broadbandmap.fcc.gov/api/public"

/**
 * The FCC's published request ceiling for the Broadband Map public API: **10 requests per MINUTE**, i.e. one every six
 * seconds. Sixty times tighter than SEC EDGAR's per-second cap, so it is the dominant cost of any BDC ingestion run.
 *
 * SOURCING, stated precisely because it could not be verified from here: this figure comes from the operator's reading
 * of the FCC's own API documentation. It was NOT confirmed against a fetchable source — the API spec is a Box-hosted
 * PDF, and `broadbandmap.fcc.gov/api-documentation` does not resolve. Treat it as the published limit as reported, not
 * as something this repo checked.
 *
 * This is the DEFAULT, not a clamp. `createSECClient` clamps because SEC's limit is verifiable, actively policed, and
 * published in fetchable HTML; none of that holds here, so pinning an unverified number as law would be false
 * precision. {@linkcode CreateBDCClientOptions.requestsPerMinute} tunes it in either direction, and the throttle meter
 * (see {@linkcode BDCClient.throttleStats}) is how a real run reports what the setting actually cost.
 *
 * If FCC ever answers with a 429, drop this to 9 before anything else: pacing exactly AT a published rate leaves no
 * headroom for event-loop jitter, and a grant that lands a millisecond late shifts into the following window. See
 * `core/api/pacer.ts`'s real-clock caveat, and `SEC_DEFAULT_REQUESTS_PER_SECOND` for the same decision taken under a
 * measurement.
 */
export const BDC_DEFAULT_REQUESTS_PER_MINUTE = 10

/**
 * Milliseconds in a minute — the numerator when turning a requests/minute budget into a pacing interval.
 */
const MS_PER_MINUTE = 60_000

/**
 * Divisors and the percentage scale {@linkcode formatBDCThrottleStats} renders through.
 */
const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const PERCENT = 100

/**
 * How long a cached BDC JSON response stays fresh by default.
 *
 * 24h, chosen against the FILING CADENCE rather than a wall-clock intuition. `listAsOfDates` gains an entry when FCC
 * publishes a new BDC vintage — twice a year (a June 30 and a December 31 `as_of_date`) — and `listAvailabilityData`
 * gains entries when a provider refiles inside an existing vintage, which happens in bursts over the weeks after a
 * vintage drops. Neither moves hour to hour, so a shorter TTL buys nothing except six seconds of throttle per repeat
 * call: at 10 requests/minute every cache hit is worth six seconds, and a `gazetteer build bdc` re-run over a handful
 * of states re-asks the same two endpoints many times.
 *
 * Not longer, either: the whole point of re-reading `listAsOfDates` is to notice a new vintage, and an entry that
 * outlived the day it was written would silently hide one — the same failure mode `createSECClient`'s mutable-endpoint
 * TTL exists to prevent. A day is far inside the weeks-long window in which anyone acts on a new filing.
 *
 * There is no immutable-forever class here the way `/Archives/` is for SEC. Every BDC JSON endpoint this client reaches
 * is an index that can gain a revision, so ONE TTL covers all of them.
 */
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Total attempts (including the first) before giving up on a 429/5xx or a network-class failure.
 */
const DEFAULT_MAX_ATTEMPTS = 3

/**
 * Base delay for the exponential backoff between retry attempts, in milliseconds.
 */
const DEFAULT_BASE_RETRY_DELAY_MS = 500

/**
 * Per-attempt socket-inactivity timeout for a JSON request, in milliseconds.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/**
 * Per-attempt socket-inactivity timeout for a zip download, in milliseconds — deliberately far longer than the JSON
 * one. A BDC availability archive is routinely hundreds of megabytes, and Axios applies `timeout` through
 * `req.setTimeout`, i.e. an idle-socket timer rather than a total-elapsed budget, so this bounds "the transfer stalled"
 * without capping how long a large but healthy download may run.
 */
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 300_000

/**
 * The status {@linkcode toArrayBuffer} reports a non-binary body under — a client misconfiguration, not an upstream
 * failure, and mapped as a `payload` kind so `isTransientResourceError` reads it as terminal.
 */
const HTTP_INTERNAL_SERVER_ERROR = 500

/**
 * The two statuses that mean "these credentials were not accepted". Both abort a run rather than skipping one file, and
 * both get the explanation in {@linkcode explainCredentialFailure}.
 */
const HTTP_UNAUTHORIZED = 401
const HTTP_FORBIDDEN = 403

/**
 * Options for {@linkcode createBDCClient}.
 */
export interface CreateBDCClientOptions {
	/**
	 * FCC Broadband Map username. Defaults to `$private.FCC_MAP_USERNAME` when omitted.
	 */
	username?: string
	/**
	 * FCC Broadband Map API key, sent as the `hash_value` header. Defaults to `$private.FCC_MAP_API_KEY` when omitted.
	 */
	apiKey?: string
	/**
	 * Requests per minute this client will dispatch. Defaults to {@linkcode BDC_DEFAULT_REQUESTS_PER_MINUTE}. NOT clamped
	 * — see that constant for why an unverified limit gets a default rather than a law.
	 */
	requestsPerMinute?: number
	/**
	 * Time source powering the throttle, the cooldown timer, and the retry backoff. Defaults to the system clock. Tests
	 * inject a fake clock so throttle and retry behavior are deterministic and instant — no wall-clock sleeps in the
	 * suite, which matters more here than anywhere else in the repo: one real grant costs six seconds.
	 */
	clock?: ClockLike
	/**
	 * On-disk cache root. Defaults to `dataRootPath("bdc", "cache", "http")`, resolved once at construction — construct
	 * the client after setting `$MAILWOMAN_DATA_ROOT`, not before.
	 */
	cacheDir?: string
	/**
	 * How long a cached JSON response stays fresh, in milliseconds. See {@linkcode DEFAULT_CACHE_TTL_MS}.
	 */
	cacheTTLMs?: number
	/**
	 * Total attempts (including the first) before giving up on a 429/5xx or a network-class failure. A STATED CEILING,
	 * not "until it works". Never applies to a 401/403/404.
	 */
	maxAttempts?: number
	/**
	 * Base delay for the exponential backoff between retry attempts, in milliseconds. Attempt `n`'s wait is
	 * `baseRetryDelayMs * 2^(n-1)`, UNLESS the response carried a `Retry-After` header, which is honored instead.
	 */
	baseRetryDelayMs?: number
	/**
	 * Per-attempt socket-inactivity timeout for a JSON request, in milliseconds.
	 */
	requestTimeoutMs?: number
	/**
	 * Per-attempt socket-inactivity timeout for a zip download, in milliseconds. See
	 * {@linkcode DEFAULT_DOWNLOAD_TIMEOUT_MS}.
	 */
	downloadTimeoutMs?: number
	/**
	 * Axios overrides, merged over this client's own defaults. THE TEST SEAM, replacing the old `fetchImpl` option: every
	 * test passes an `adapter` here, so no test in this workspace ever performs a live network call. Overriding `headers`
	 * wholesale would drop the credential pair, so don't.
	 */
	axios?: APIClientConfig["axios"]
}

/**
 * Query-string parameter values a {@linkcode BDCClient.get} call may carry. `undefined` values are omitted rather than
 * serialized as the literal string `"undefined"`.
 */
export type BDCQueryParams = Record<string, string | number | undefined>

/**
 * Per-call overrides for {@linkcode BDCClient.get}.
 */
export interface BDCGetOptions {
	/**
	 * Bypass the response cache for THIS call — both the read and the write. The request still clears the throttle, so a
	 * caller cannot use this to dodge the rate budget, only the staleness.
	 */
	skipCache?: boolean
}

/**
 * What a run spent waiting on the request throttle, as reported by {@linkcode BDCClient.throttleStats}.
 */
export interface BDCThrottleStats {
	/**
	 * Milliseconds since the client was constructed, on the client's own clock.
	 */
	elapsedMs: number
	/**
	 * Milliseconds this client spent asleep. Almost entirely throttle waits; a retry backoff after a 429/5xx also lands
	 * here, which is deliberate — both are time the upstream's limits cost the run, and separating them would need a hook
	 * `APIClient` does not expose.
	 */
	waitingMs: number
	/**
	 * How many separate waits made up {@linkcode BDCThrottleStats.waitingMs}.
	 */
	waits: number
	/**
	 * How many times the per-minute BUDGET gate opened a cooldown, counted off `APIClient`'s `cooldown_start` event. With
	 * the interval gate also configured this is normally one per budget's worth of requests, each of near-zero duration —
	 * a window-rollover marker rather than a wait. See {@linkcode createBDCClient} for why both gates are set.
	 */
	cooldowns: number
}

/**
 * {@linkcode APIClient} configuration plus the BDC-specific fields {@linkcode BDCClient} reads back off `config`.
 */
export interface BDCClientConfig extends APIClientConfig {
	/**
	 * The username half of the credential pair. Named in the 401/403 explanation so a maintainer can see which account
	 * was actually used; the key half is never echoed.
	 */
	username: string
	/**
	 * Per-attempt socket-inactivity timeout applied to the binary path only, overriding the instance-wide `axios.timeout`
	 * that governs JSON requests.
	 */
	downloadTimeoutMs: number
	/**
	 * Snapshot the throttle meter. Installed by {@linkcode createBDCClient}, which owns the metering clock the meter reads
	 * through.
	 */
	readThrottleStats: () => BDCThrottleStats
}

/**
 * The request-config shape {@linkcode APIClient.fetch} accepts, reached through `APIClient` rather than by importing
 * `axios` — `bdc` depends on neither `axios` nor `axios-cache-interceptor`, reaching both only through
 * `@mailwoman/core`, exactly as `filer` does.
 */
type BDCRequestConfig = Parameters<APIClient["fetch"]>[0]

/**
 * A request config carrying `axios-cache-interceptor`'s per-request cache switch.
 *
 * The interceptor declares `cache` on its OWN `CacheRequestConfig` rather than augmenting Axios's `AxiosRequestConfig`,
 * so the field is invisible to `APIClient.fetch`'s parameter type and an inline object literal would fail
 * excess-property checking. Declaring the intersection here and passing a VARIABLE of this type is what makes it
 * typecheck without reaching for `any`, without importing the interceptor, and — the point of the exercise — without
 * any change to `core/api`. The interceptor's request hook short-circuits on `config.cache === false` before it touches
 * storage at all, and its response hook then skips the write for the same reason.
 */
type UncachedBDCRequestConfig = BDCRequestConfig & {
	cache: false
}

/**
 * Build the absolute request URL for `path`, with `params` as its query string.
 *
 * `path` is APPENDED to {@linkcode BDC_API_BASE_URL}, never RESOLVED against it. That distinction is load-bearing: `new
 * URL("https://elsewhere.example/x", BDC_API_BASE_URL)` would resolve to `elsewhere.example` and carry the credential
 * header pair there, while string concatenation can only ever produce a path under the BDC origin.
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
 * Rewrite a credential rejection into an error that names the cause. A bare "401 Unauthorized" from an FCC endpoint
 * reads as "the resource is missing" or "we're blocked", and this project has already lost a debugging cycle to exactly
 * that on a generic FCC 403. The status and URN are reconstructed identically, so a caller's `status === 401` branch is
 * unaffected; anything that is not a credential rejection is rethrown untouched.
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
 * Axios's Node adapter hands back a `Buffer` for `responseType: "arraybuffer"` (it only stringifies for every OTHER
 * response type), while its fetch adapter hands back a real `ArrayBuffer` — so both shapes have to be accepted, and the
 * `Buffer` one is what production actually sees. The zero-copy branch matters: these bodies are hundreds of megabytes,
 * and `Buffer.concat` allocates a dedicated, exactly-sized backing store for anything past Node's small-buffer pool, so
 * the view spans its whole `ArrayBuffer` and can be handed over as-is.
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
			'misconfiguration (the request must carry `responseType: "arraybuffer"`), not an upstream failure.',
		"axios",
		"payload",
		"not-binary"
	)
}

/**
 * A constructed FCC BDC public-API client. Build one with {@linkcode createBDCClient}, which resolves the credentials,
 * the throttle, the cache, and every default.
 */
export class BDCClient extends APIClient<BDCClientConfig> {
	/**
	 * Issue an authenticated `GET` against the BDC public API and parse the JSON response body, subject to the on-disk
	 * cache, the request throttle, and bounded retry.
	 *
	 * `path` is appended to {@linkcode BDC_API_BASE_URL} as-is (a leading slash, e.g. `/map/listAsOfDates`). `params`
	 * become the request's query string; the response body is returned UN-unwrapped — every BDC endpoint nests its
	 * payload under a `data` key (`{ data: [...] }`), so callers pluck `.data` themselves at the call site.
	 *
	 * Concurrent calls for the same URL that both miss the cache share a single in-flight request — the cache
	 * interceptor's own stampede guard, which the raw-`fetch` client had no equivalent of.
	 */
	public async get<T>(path: string, params?: BDCQueryParams, options: BDCGetOptions = {}): Promise<T> {
		const url = buildBDCURL(path, params)

		const config: UncachedBDCRequestConfig | BDCRequestConfig = options.skipCache
			? { url: url.toString(), cache: false }
			: { url: url.toString() }

		return this.#request<T>(config, url)
	}

	/**
	 * Issue an authenticated `GET` and return the raw response body as an `ArrayBuffer` — the binary counterpart to
	 * {@linkcode BDCClient.get}. Used for the zip-wrapped availability downloads (`downloadBDCFile` in `./download.ts`),
	 * where the response is a `.zip` archive rather than a JSON envelope.
	 *
	 * CACHING IS OFF FOR THIS PATH, deliberately, and it is not a tunable. The response cache validates and persists
	 * JSON: it would reject a zip on the way in (the validator requires a `data`-keyed object), and even if it accepted
	 * one, serializing a multi-hundred-megabyte archive through `JSON.stringify` into a hash-named file would be a second
	 * copy of a thing `downloadBDCFile` already writes to disk itself — which is also where its real cache check lives
	 * (it returns the extracted CSV's path without issuing any request when that file exists). Two disk copies of the
	 * same archive, one of them unreadable.
	 *
	 * The throttle still applies: skipping the cache is not a way around the rate budget.
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
	 * What this client has spent waiting on the throttle so far. At six seconds a grant, a bulk ingest is throttle-bound
	 * by construction, and this is the measurement to assess a rate change against — see
	 * {@linkcode formatBDCThrottleStats} for the one-line rendering `gazetteer build bdc` prints.
	 */
	public throttleStats(): BDCThrottleStats {
		return this.config.readThrottleStats()
	}

	/**
	 * Issue one request and return its body, with a credential rejection explained. Shared by both public methods so the
	 * explanation cannot drift between the JSON and binary paths.
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
 * `123456` → `"2m 3s"`. Whole seconds only: nothing this measures is sub-second.
 */
function formatDuration(ms: number): string {
	const totalSeconds = Math.round(ms / MS_PER_SECOND)
	const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE)
	const seconds = totalSeconds % SECONDS_PER_MINUTE

	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

/**
 * A {@linkcode ClockLike} that records how long the client spends asleep, plus the reader that snapshots it.
 *
 * The clock is the only seam `APIClient` exposes that every wait passes through — the pacer sleeps on it, the cooldown
 * timer sleeps on it, and the retry backoff sleeps on it — so wrapping it is how the waiting becomes visible without
 * touching `core/api`.
 *
 * WAITS ARE UNIONED, NOT SUMMED, and that is the whole subtlety here. Under a concurrent fan-out every caller sleeps at
 * once, and each one's wait is longer than the last: 40 concurrent requests at a 6 s interval sleep 6 s, 12 s, … 234 s,
 * which SUMS to 78 minutes of "waiting" inside a run that took 3m54s — measured, and reported as `2000%` by the first
 * version of this meter. Tracking the depth of in-flight sleeps and charging only the wall-clock span during which at
 * least one was outstanding answers the question actually being asked: how much of the elapsed time went to the
 * throttle rather than to transferring. For the serial ingest `gazetteer build bdc` actually performs the two are
 * identical.
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
				// A zero-length sleep is a scheduling yield, not a wait — `setCooldown` issues one on every
				// budget rollover, and counting those would report a wait per ten requests that never happened.
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
 * Create an FCC Broadband Data Collection public-API client. See the file header for the full rationale.
 *
 * Throws immediately, before any request is made, when constructed without explicit credentials AND without the
 * `FCC_MAP_USERNAME`/`FCC_MAP_API_KEY` environment values.
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
		// BOTH GATES, on purpose, and the interval is the one that holds the rate.
		//
		// `requestsPerMinute` alone does NOT deliver N requests per minute. It is a budget model whose
		// cooldown is `MS_PER_MINUTE / N` minus the gap since the previous dispatch — so N dispatches go out
		// back to back and the client then waits 60000/N ms, i.e. N requests every 60/N SECONDS. Measured
		// against a bare `APIClient` at `requestsPerMinute: 10` with a 20-call fan-out on a virtual clock:
		// arrivals at `[0 x10, 6000 x10]`, i.e. 20 inside one sliding minute against a budget of 10, and a
		// sustained 100 requests/minute — ten times the published limit. `minRequestIntervalMs` is the gate
		// that actually spaces dispatches, and it is what makes this client honor 10/minute.
		//
		// The budget is still declared rather than dropped: the two gates compose (both must clear), it costs
		// nothing here — its cooldown computes to <= 0 once the interval gate has already spaced the
		// dispatches, so it fires as a zero-length window rollover — and it states the intent in the option
		// whose name matches the published limit. If `requestsPerMinute` is ever corrected in `core/api` to
		// mean what it says, this client already declares the right budget and the interval becomes a
		// redundant second ceiling rather than the load-bearing one.
		requestsPerMinute,
		minRequestIntervalMs: Math.ceil(MS_PER_MINUTE / requestsPerMinute),
		retry: {
			maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
			baseDelayMs: options.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS,
		},
		clock: meter.clock,
		caching: {
			storage: buildDiskStorage({
				directory: options.cacheDir ?? dataRootPath("bdc", "cache", "http"),
				// Validate BEFORE writing. Every BDC endpoint answers with a `data`-keyed envelope, so a
				// decoded body that isn't one means the upstream served something other than what it
				// claimed — an error page, a login redirect — and persisting that would hand the next run a
				// body its caller will destructure into `undefined`.
				validate: (value) => isBDCEnvelope(value.data?.data),
			}),
			ttl: options.cacheTTLMs ?? DEFAULT_CACHE_TTL_MS,
			// The TTL above is chosen against the FCC's filing cadence. Letting a response header override
			// it would silently replace that reasoning with whatever the CDN in front of broadbandmap.fcc.gov
			// happens to send.
			interpretHeader: false,
			// NO `cachePredicate` HERE, deliberately. "Never cache a failure" is a real property and it is
			// tested, but it is already guaranteed upstream: Axios's default `validateStatus` rejects
			// anything outside 200-299 before the cache interceptor's response hook ever runs, so the
			// predicate only ever sees a 2xx and a narrower `statusCheck` cannot change any outcome. A
			// narrowed one was written here first and MUTATION-PROVED UNFALSIFIABLE — deleting it caused zero
			// test failures — so it was removed rather than left as decoration. (It could not have been
			// harmful either: the interceptor consults the predicate only when there is no existing entry,
			// `!cache.data && !testCachePredicate(...)`, so it never sees a 304 revalidation.)
		},
		axios: {
			headers: {
				// NOT bearer, NOT basic — the BDC API takes the credential pair as two plain headers.
				username,
				hash_value: apiKey,
			},
			timeout: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
			responseType: "json",
			// `silentJSONParsing` defaults to TRUE, which makes Axios hand back the RAW STRING when a body
			// fails to parse instead of raising. An upstream serving an HTML error page under a 200 would
			// then be returned as `T` and destructured into `undefined` at the call site; parse failures
			// must be errors.
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
 * Whether a decoded response body is the `{ data: … }` envelope every BDC endpoint answers with.
 */
function isBDCEnvelope(body: unknown): boolean {
	return typeof body === "object" && body !== null && "data" in body
}
