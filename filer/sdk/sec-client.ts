/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file SEC EDGAR HTTP client — the repo's first throttled fetcher (3b decision 5).
 *
 *   SEC's fair-access policy (https://www.sec.gov/os/accessing-edgar-data, verified against source
 *   2026-07-31) declares a max request rate of 10/second and asks for a descriptive `User-Agent`
 *   naming a company + contact address, plus `Accept-Encoding: gzip, deflate`. Unlike
 *   `bdc/sdk/client.ts` (one host, no rate limiting/caching/retry) and `filer/sdk`, which shipped no
 *   fetcher at all before this, this client builds in all four disciplines decision 5 asked for:
 *
 *     1. UA fail-fast off `$private.SEC_EDGAR_USER_AGENT`, mirroring `bdc/sdk/client.ts:78-83`.
 *     2. A token-bucket rate limiter clamped to <= 10 req/s ({@linkcode SEC_MAX_REQUESTS_PER_SECOND}),
 *        driven by an injectable {@linkcode ClockLike} so tests never sleep on the wall clock.
 *     3. An on-disk cache under `dataRootPath("sec", "cache")`, keyed by the request URL's SHA-256.
 *        Archive documents never expire; every other endpoint gets a TTL — see
 *        {@linkcode isImmutableArchiveURL} for the reasoning.
 *     4. Bounded retry with backoff on 429/5xx — never on 403 (see below).
 *
 *   Unlike `BDCClient.get`, which appends a path onto one shared base URL, {@linkcode SECClient.get}
 *   takes a full absolute URL: EDGAR is served across (at least) two hosts — `www.sec.gov` and
 *   `data.sec.gov` — so there's no single base to append a relative path to.
 *
 *   A bare 403 from sec.gov means "you didn't identify yourself": reproduced by hitting the same URL
 *   with and without a compliant UA — no UA is a 403, a descriptive one is a 200. It does NOT mean the
 *   resource is missing or that this client/IP is blocked, and retrying it would just burn the 10 req/s
 *   budget on a request that can never succeed, so 403 is treated as non-retryable and the thrown error
 *   says all of this explicitly (this project already lost time to the analogous failure mode on an FCC
 *   endpoint — a generic "403 Forbidden" sends a future maintainer down exactly the wrong path).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"

import { $private } from "@mailwoman/core/env"
import { dataRootPath, sha256Hex } from "@mailwoman/core/utils"
import { resolvePath } from "path-ts"

/**
 * A minimal, injectable time source. Every wall-clock-facing part of this client — the token-bucket rate limiter's wait
 * and the retry backoff — reads through this seam instead of calling `Date.now()` / `setTimeout` directly, so tests can
 * drive both deterministically without ever sleeping for real.
 */
export interface ClockLike {
	now(): number
	sleep(ms: number): Promise<void>
}

/**
 * The real-time {@linkcode ClockLike}, used whenever a caller doesn't inject one.
 */
export const systemClock: ClockLike = {
	now: () => Date.now(),
	sleep: (ms) => delay(ms),
}

/**
 * The SEC fair-access policy's stated ceiling (https://www.sec.gov/os/accessing-edgar-data): "Current max request rate:
 * 10 requests/second." {@linkcode TokenBucket} clamps to this regardless of a caller-supplied rate, so a misconfigured
 * caller can't accidentally push this client over the policy limit.
 */
export const SEC_MAX_REQUESTS_PER_SECOND = 10

/**
 * A token-bucket rate limiter. Starts full (an immediate burst of `capacity` requests), refills continuously at
 * `capacity` tokens/second, and {@linkcode TokenBucket.acquire} resolves immediately while a token is available or
 * awaits the clock's `sleep` for exactly as long as the next token takes to accrue.
 */
export class TokenBucket {
	readonly #capacity: number
	readonly #capacityPerMs: number
	readonly #clock: ClockLike
	#tokens: number
	#lastRefillAt: number

	/**
	 * @param ratePerSecond Desired tokens/second. Clamped to `[1, SEC_MAX_REQUESTS_PER_SECOND]` — never more than the
	 *   policy ceiling, never less than 1 (a 0-capacity bucket could never refill).
	 * @param clock Time source for both refill accounting and the wait when the bucket is empty. Defaults to
	 *   {@linkcode systemClock}.
	 */
	constructor(ratePerSecond: number, clock: ClockLike = systemClock) {
		this.#capacity = Math.max(1, Math.min(ratePerSecond, SEC_MAX_REQUESTS_PER_SECOND))
		this.#capacityPerMs = this.#capacity / 1000
		this.#clock = clock
		this.#tokens = this.#capacity
		this.#lastRefillAt = clock.now()
	}

	/**
	 * Resolve once a token is available, consuming it. A full bucket returns immediately; an empty one awaits
	 * `clock.sleep` for the exact deficit before consuming.
	 */
	async acquire(): Promise<void> {
		this.#refill()

		if (this.#tokens < 1) {
			const deficitTokens = 1 - this.#tokens
			const waitMs = Math.ceil(deficitTokens / this.#capacityPerMs)

			await this.#clock.sleep(waitMs)
			this.#refill()
		}

		this.#tokens = Math.max(0, this.#tokens - 1)
	}

	#refill(): void {
		const now = this.#clock.now()
		const elapsedMs = now - this.#lastRefillAt

		if (elapsedMs <= 0) return

		this.#tokens = Math.min(this.#capacity, this.#tokens + elapsedMs * this.#capacityPerMs)
		this.#lastRefillAt = now
	}
}

/**
 * EDGAR archive documents (10-Ks, Exhibit 21 subsidiary lists, and every other filing exhibit) live at a path of this
 * shape once submitted, e.g. `https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/aapl-20230930.htm`. SEC
 * does not revise a filed document in place — a correction is a NEW filing at a new path — so a document fetched today
 * reads identically a year from now. Caching these forever is the correct, deliberate choice: it saves a network
 * round-trip (and rate-limit budget) on every re-run with zero staleness risk.
 *
 * Every other endpoint this client is asked to reach — the submissions index (`/submissions/CIK##########.json`), the
 * ticker map (`/files/company_tickers.json`), and the classic browse-edgar CGI — is a live index that changes as new
 * filings land or tickers get reassigned. Caching those forever would be the WRONG choice (a stale submissions index
 * would silently hide a company's newest 10-K from tasks 6-8), so entries for URLs this returns `false` for expire
 * after `cacheTTLMs` instead. See {@linkcode createSECClient}'s `cacheTTLMs` option.
 */
export function isImmutableArchiveURL(url: URL): boolean {
	return SEC_ARCHIVE_PATH_PATTERN.test(url.pathname)
}

const SEC_ARCHIVE_PATH_PATTERN = /^\/Archives\/edgar\/data\//

/**
 * The on-disk shape of one cached response, keyed externally by the SHA-256 of its request URL (see
 * {@linkcode cacheFilePath}). `url` is carried for debuggability (a maintainer inspecting `dataRootPath("sec", "cache")`
 * shouldn't have to reverse a hash to know what a file holds); `fetchedAt` is read from the client's
 * {@linkcode ClockLike}, not the filesystem mtime, so cache-TTL tests can control "elapsed time" deterministically via a
 * fake clock instead of touching real file timestamps.
 */
interface SECCacheEntry {
	url: string
	fetchedAt: number
	body: string
}

/**
 * The cache root: `cacheDir` when the caller supplied one, else `dataRootPath("sec", "cache")`
 * (`$MAILWOMAN_DATA_ROOT/sec/cache`). Resolved fresh on every call rather than memoized at client construction,
 * matching `dataRootPath`'s own documented live-read contract (a late `$MAILWOMAN_DATA_ROOT` change is honored).
 */
function resolveCacheDir(cacheDir: string | undefined): string {
	return cacheDir ?? dataRootPath("sec", "cache")
}

function cacheFilePath(url: URL, cacheDir: string | undefined): string {
	return resolvePath(resolveCacheDir(cacheDir), `${sha256Hex(url.toString())}.json`)
}

/**
 * Read a cache entry for `url`, honoring the immutable-archive-vs-TTL rule documented on
 * {@linkcode isImmutableArchiveURL}. Returns `null` on a cache miss, a corrupt entry (treated as a miss — safer to
 * re-fetch than to throw on a half-written file), or a stale (expired) entry.
 */
async function readCacheEntry(
	url: URL,
	cacheDir: string | undefined,
	cacheTTLMs: number,
	clock: ClockLike
): Promise<string | null> {
	let raw: string

	try {
		raw = await readFile(cacheFilePath(url, cacheDir), "utf8")
	} catch {
		return null
	}

	let entry: SECCacheEntry

	try {
		entry = JSON.parse(raw) as SECCacheEntry
	} catch {
		return null
	}

	const isFresh = isImmutableArchiveURL(url) || clock.now() - entry.fetchedAt < cacheTTLMs

	return isFresh ? entry.body : null
}

async function writeCacheEntry(url: URL, body: string, cacheDir: string | undefined, clock: ClockLike): Promise<void> {
	const entry: SECCacheEntry = { url: url.toString(), fetchedAt: clock.now(), body }

	await mkdir(resolveCacheDir(cacheDir), { recursive: true })
	await writeFile(cacheFilePath(url, cacheDir), JSON.stringify(entry, null, "\t"))
}

/**
 * Rate limited — retryable, the server is asking us to back off.
 */
const HTTP_TOO_MANY_REQUESTS = 429

/**
 * The UA didn't identify itself — NOT retryable. See the file header.
 */
const HTTP_FORBIDDEN = 403

/**
 * Lowest 5xx status. Server-side failures are retryable.
 */
const HTTP_SERVER_ERROR_MIN = 500

/**
 * Highest 5xx status.
 */
const HTTP_SERVER_ERROR_MAX = 599

function isRetryableStatus(status: number): boolean {
	return status === HTTP_TOO_MANY_REQUESTS || (status >= HTTP_SERVER_ERROR_MIN && status <= HTTP_SERVER_ERROR_MAX)
}

/**
 * Options for {@linkcode createSECClient}.
 */
export interface CreateSECClientOptions {
	/**
	 * SEC EDGAR fair-access User-Agent, e.g. `"Nirrius, LLC support@nirri.us"`. Defaults to
	 * `$private.SEC_EDGAR_USER_AGENT` when omitted.
	 */
	userAgent?: string
	/**
	 * Test seam — overrides the `fetch` implementation the client issues requests through. Defaults to
	 * `globalThis.fetch`. No test in this workspace ever performs a live network call; every test supplies a stub here
	 * (decision 5).
	 */
	fetchImpl?: typeof fetch
	/**
	 * Desired requests/second. Clamped to `[1, SEC_MAX_REQUESTS_PER_SECOND]` regardless of what's passed — see
	 * {@linkcode TokenBucket}. Defaults to {@linkcode SEC_MAX_REQUESTS_PER_SECOND}.
	 */
	requestsPerSecond?: number
	/**
	 * Time source powering the rate limiter's wait and the retry backoff. Defaults to {@linkcode systemClock}. Tests
	 * inject a fake clock so rate-limit and retry behavior are deterministic and fast — no wall-clock sleeps in the
	 * suite.
	 */
	clock?: ClockLike
	/**
	 * On-disk cache root. Defaults to `dataRootPath("sec", "cache")`.
	 */
	cacheDir?: string
	/**
	 * How long a cached entry for a MUTABLE endpoint (anything {@linkcode isImmutableArchiveURL} returns `false` for)
	 * stays fresh, in milliseconds. Default 24h — generous enough to avoid re-hammering the submissions index/ticker map
	 * on every run, short enough that a day-old crosswalk build still notices a company's newest 10-K. Archive documents
	 * ignore this entirely (see {@linkcode isImmutableArchiveURL}).
	 */
	cacheTTLMs?: number
	/**
	 * Total attempts (including the first) before giving up on a 429/5xx. Default 3 — a STATED CEILING, not "until it
	 * works." Exhausting this rethrows the last transient error. Never applies to a 403, which fails immediately on the
	 * first attempt (see the file header).
	 */
	maxAttempts?: number
	/**
	 * Base delay for the exponential backoff between retry attempts, in milliseconds. Attempt `n`'s wait is
	 * `baseRetryDelayMs * 2^(n-1)`. Default 500.
	 */
	baseRetryDelayMs?: number
}

/**
 * A constructed SEC EDGAR client, as returned by {@linkcode createSECClient}.
 */
export interface SECClient {
	/**
	 * Issue a `GET` request against a full absolute EDGAR URL and parse the JSON response body, subject to the on-disk
	 * cache, the token-bucket rate limiter, and bounded 429/5xx retry (decision 5). Throws immediately (no retry) on a
	 * 403 — see the file header — and after `maxAttempts` on a persistent 429/5xx.
	 */
	get<T>(url: string | URL): Promise<T>
}

/**
 * Create a SEC EDGAR HTTP client — the repo's first throttled fetcher (3b decision 5). See the file header for the full
 * rationale.
 *
 * Throws immediately, before any request is made, when constructed without an explicit `userAgent` AND without
 * `SEC_EDGAR_USER_AGENT` set — a silently-UA-less client would just 403 on first use, which is a worse failure mode
 * than failing fast at construction (mirrors `bdc/sdk/client.ts:78-83`).
 */
export function createSECClient(options: CreateSECClientOptions = {}): SECClient {
	const userAgent = options.userAgent ?? $private.SEC_EDGAR_USER_AGENT

	if (!userAgent) {
		throw new Error(
			"createSECClient: missing a SEC EDGAR User-Agent. Pass `userAgent` explicitly, or set the " +
				'`SEC_EDGAR_USER_AGENT` environment variable to a descriptive "Company Name AdminContact@domain.com" ' +
				"value. SEC's fair-access policy (https://www.sec.gov/os/accessing-edgar-data) rejects requests that " +
				"don't identify a company and contact address with a 403 — failing fast here avoids burning a request " +
				"(and rate-limit budget) on a call that's certain to be rejected."
		)
	}

	const fetchImpl = options.fetchImpl ?? globalThis.fetch
	const clock = options.clock ?? systemClock
	const cacheDir = options.cacheDir
	const cacheTTLMs = options.cacheTTLMs ?? 24 * 60 * 60 * 1000
	const maxAttempts = options.maxAttempts ?? 3
	const baseRetryDelayMs = options.baseRetryDelayMs ?? 500
	const bucket = new TokenBucket(options.requestsPerSecond ?? SEC_MAX_REQUESTS_PER_SECOND, clock)

	/**
	 * Issue the actual network request(s) for a cache miss: rate-limited, with bounded 429/5xx retry. Never consults or
	 * writes the cache — that's {@linkcode get}'s job.
	 */
	async function fetchFresh(url: URL): Promise<string> {
		let lastError: Error | undefined

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			await bucket.acquire()

			// Per the SEC's documented sample headers (https://www.sec.gov/os/accessing-edgar-data):
			// a descriptive User-Agent plus Accept-Encoding. `Host` is also in that sample, but this
			// client spans multiple hosts (www.sec.gov, data.sec.gov) — `fetch` derives Host from the
			// URL itself, and hardcoding one here would break requests to the other host.
			const response = await fetchImpl(url, {
				headers: {
					"User-Agent": userAgent,
					"Accept-Encoding": "gzip, deflate",
				},
			})

			if (response.ok) {
				return response.text()
			}

			if (response.status === HTTP_FORBIDDEN) {
				throw new Error(
					`SEC EDGAR request failed: 403 Forbidden (${url}). A bare 403 from sec.gov means the request did ` +
						`NOT identify itself — it does NOT mean the resource is missing or that this client/IP is ` +
						`blocked. SEC's fair-access policy (https://www.sec.gov/os/accessing-edgar-data) rejects ` +
						`requests without a descriptive "Company Name AdminContact@domain.com" User-Agent. The ` +
						`configured UA was "${userAgent}". This is not retried — retrying a 403 cannot succeed and ` +
						`would only burn the 10 req/s rate budget.`
				)
			}

			if (!isRetryableStatus(response.status)) {
				throw new Error(`SEC EDGAR request failed: ${response.status} ${response.statusText} (${url})`)
			}

			lastError = new Error(`SEC EDGAR request failed: ${response.status} ${response.statusText} (${url})`)

			if (attempt < maxAttempts) {
				await clock.sleep(baseRetryDelayMs * 2 ** (attempt - 1))
			}
		}

		throw lastError ?? new Error(`SEC EDGAR request failed after ${maxAttempts} attempts (${url})`)
	}

	async function get<T>(input: string | URL): Promise<T> {
		const url = input instanceof URL ? input : new URL(input)
		const cachedBody = await readCacheEntry(url, cacheDir, cacheTTLMs, clock)

		if (cachedBody !== null) {
			return JSON.parse(cachedBody) as T
		}

		const body = await fetchFresh(url)

		await writeCacheEntry(url, body, cacheDir, clock)

		return JSON.parse(body) as T
	}

	return { get }
}
