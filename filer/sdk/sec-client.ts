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
 *   fetcher at all before this, this client builds in the disciplines decision 5 asked for, hardened by
 *   a review pass that found one critical concurrency bug and several gaps:
 *
 *     1. UA fail-fast off `$private.SEC_EDGAR_USER_AGENT`, mirroring `bdc/sdk/client.ts:78-83`.
 *     2. A token-bucket rate limiter clamped to <= 10 req/s ({@linkcode SEC_MAX_REQUESTS_PER_SECOND}),
 *        driven by an injectable {@linkcode ClockLike} so tests never sleep on the wall clock.
 *        {@linkcode TokenBucket.acquire}'s docstring covers a real concurrency bug review found here —
 *        a `Promise.all`-fanned-out burst of `get()` calls bypassed the limiter almost entirely.
 *     3. A validated-before-write, atomic (write-then-rename, matching `filer/sdk/build-filer.ts`'s
 *        convention), stampede-guarded on-disk cache under `dataRootPath("sec", "cache")`, keyed by the
 *        request URL's SHA-256. Archive documents never expire; every other endpoint gets a TTL — see
 *        {@linkcode isImmutableArchiveURL} for the reasoning.
 *     4. Bounded retry with backoff on 429/5xx AND network errors (a dropped socket is more common than
 *        a 503 for a bulk crawler) — never on 403 (see below). Honors a response's `Retry-After` header,
 *        clamped to a sane ceiling. Every attempt carries a per-request timeout (`AbortSignal`), so a
 *        never-settling `fetchImpl` can't hang `get()` forever.
 *     5. A typed {@linkcode SECRequestError} (`status`/`url`/`retryable`) for HTTP-status failures, so a
 *        caller (tasks 6-8) can branch on `status`/`retryable` instead of regexing a message string.
 *     6. A host allowlist (`www.sec.gov`, `data.sec.gov`) — this is the designated SEC client; it
 *        refuses to send the configured UA (a contact address) to an arbitrary caller-supplied host.
 *
 *   Unlike `BDCClient.get`, which appends a path onto one shared base URL, {@linkcode SECClient.get}
 *   takes a full absolute URL: EDGAR is served across (at least) two hosts — `www.sec.gov` and
 *   `data.sec.gov` — so there's no single base to append a relative path to. (2) above restricts `get`
 *   to exactly those two hosts.
 *
 *   A bare 403 from sec.gov means "you didn't identify yourself": reproduced by hitting the same URL
 *   with and without a compliant UA — no UA is a 403, a descriptive one is a 200. It does NOT mean the
 *   resource is missing or that this client/IP is blocked, and retrying it would just burn the 10 req/s
 *   budget on a request that can never succeed, so 403 is treated as non-retryable and the thrown error
 *   says all of this explicitly (this project already lost time to the analogous failure mode on an FCC
 *   endpoint — a generic "403 Forbidden" sends a future maintainer down exactly the wrong path).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { $private } from "@mailwoman/core/env"
import { dataRootPath, sha256Hex } from "@mailwoman/core/utils"

/**
 * A minimal, injectable time source. Every wall-clock-facing part of this client — the token-bucket rate limiter's wait
 * and the retry backoff — reads through this seam instead of calling `Date.now()` / `setTimeout` directly, so tests can
 * drive both deterministically without ever sleeping for real. (The per-request timeout is a separate seam — see
 * `CreateSECClientOptions.requestTimeoutMs` — because it's wired through the platform's real `AbortSignal.timeout`, not
 * this injectable clock.)
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
 * 10 requests/second." {@linkcode TokenBucket} clamps its capacity (and steady-state refill rate) to this regardless of
 * a caller-supplied rate, so a misconfigured caller can't accidentally push the sustained rate over the policy limit.
 *
 * This does NOT mean no more than 10 requests ever leave within any given second — see the "deliberate trade-off" note
 * on {@linkcode TokenBucket}'s constructor for the one-time startup-burst exception to that.
 */
export const SEC_MAX_REQUESTS_PER_SECOND = 10

/**
 * A token-bucket rate limiter. Starts FULL — an immediate, one-time burst of up to `capacity` requests before any
 * pacing kicks in — then refills continuously at `capacity` tokens/second; {@linkcode TokenBucket.acquire} resolves
 * immediately while a token is available or awaits the clock's `sleep` for exactly as long as the next token takes to
 * accrue.
 *
 * DELIBERATE TRADE-OFF (starting full, not empty): a cold client's first ~`capacity` requests (plus whatever trickles
 * in via refill during that same window) can land inside the first second, which briefly exceeds a strict "never more
 * than 10 in any 1-second window" reading of SEC's policy. Starting empty instead would remove that burst, but would
 * also force a fresh client's very first request to wait ~100ms for a token to accrue — worse for the common case (a
 * single request, or a short crawl-startup), and this client is meant to be constructed once and reused across a long
 * crawl (tasks 6-8), where a single one-time ≤10-request burst is negligible against thousands of subsequent,
 * correctly-paced requests. This is the standard token-bucket reading of a rate cap; noted here explicitly rather than
 * silently shipped, per review.
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
	 * Resolve once a token is available, consuming it. A full bucket returns immediately; an empty one loops — wait for
	 * the deficit, THEN RE-CHECK — because concurrent callers can wake at the exact same instant (all driven by the same
	 * clock) and each must independently reconfirm a token is still there before consuming one.
	 *
	 * Two things matter for correctness under concurrency that are easy to get backwards — both were a single live bug
	 * review found here (reproduced with N `acquire()` calls fanned out via `Promise.all`, e.g. through
	 * `Promise.all(urls.map(u => client.get(u)))`, under an injected clock: 40 concurrent calls issued 40 requests inside
	 * 100ms of virtual time against a published 10 req/s ceiling, 30 of them sharing a single instant):
	 *
	 * 1. `while`, not `if`: a waiter that wakes must RE-VERIFY `#tokens >= 1` before consuming — another waiter woken at
	 *    that same instant may have already claimed the one token that just accrued. An `if` lets every waiter that
	 *    entered the wait proceed unconditionally the moment ANY one of them wakes, regardless of whether a token was
	 *    actually left for it.
	 * 2. No floor-clamping the decrement to zero: letting `#tokens` go negative (a "debt") is what makes each waiter's OWN
	 *    deficit calculation (`deficitTokens = 1 - #tokens`) correctly account for every other waiter that has already
	 *    claimed a token ahead of it. Clamping at zero erases that debt and lets a whole cohort of over-capacity waiters
	 *    through at once instead of pacing them one per `1000 / capacity` ms.
	 */
	async acquire(): Promise<void> {
		this.#refill()

		while (this.#tokens < 1) {
			const deficitTokens = 1 - this.#tokens
			const waitMs = Math.ceil(deficitTokens / this.#capacityPerMs)

			await this.#clock.sleep(waitMs)
			this.#refill()
		}

		this.#tokens -= 1
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
 * The only hosts this client will ever send a request to. `get()` refuses (before any cache/rate-limit/network
 * activity) a URL on any other host — this is the designated SEC EDGAR client, and its configured User-Agent carries a
 * real contact address; sending that anywhere a caller happens to point it would leak it outside SEC's fair-access
 * program for no benefit.
 */
const SEC_ALLOWED_HOSTS = new Set(["www.sec.gov", "data.sec.gov"])

function assertSECHost(url: URL): void {
	if (!SEC_ALLOWED_HOSTS.has(url.hostname)) {
		throw new Error(
			`createSECClient: refusing to request "${url}" — this client only sends requests to SEC EDGAR hosts ` +
				`(${[...SEC_ALLOWED_HOSTS].join(", ")}). Sending the configured User-Agent (a contact address) to an ` +
				"arbitrary caller-supplied host would leak it outside SEC's fair-access program."
		)
	}
}

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

/**
 * `resolveCacheDir` already returns an absolute directory (either the caller's absolute override or `dataRootPath`'s
 * absolute result), and the filename is always a hex digest + `.json` — plain `node:path` `join` is all that's needed
 * here. (An earlier version pulled in `path-ts`'s `resolvePath` for this, which left `path-ts` an undeclared dependency
 * of a PUBLISHED workspace — `filer/package.json` never listed it, so it only resolved via root hoisting; a consumer on
 * pnpm or Yarn PnP would have hit `MODULE_NOT_FOUND`.)
 */
function cacheFilePath(url: URL, cacheDir: string | undefined): string {
	return join(resolveCacheDir(cacheDir), `${sha256Hex(url.toString())}.json`)
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

/**
 * Write a cache entry via write-then-rename — never straight to the final path — matching `filer/sdk/build-filer.ts`'s
 * build-then-move convention: a reader can never observe a half-written entry, and a crash mid-write leaves only an
 * orphaned `.building` file rather than a corrupt cache entry.
 */
async function writeCacheEntry(url: URL, body: string, cacheDir: string | undefined, clock: ClockLike): Promise<void> {
	const entry: SECCacheEntry = { url: url.toString(), fetchedAt: clock.now(), body }
	const finalPath = cacheFilePath(url, cacheDir)
	const buildingPath = `${finalPath}.building`

	await mkdir(resolveCacheDir(cacheDir), { recursive: true })
	await writeFile(buildingPath, JSON.stringify(entry, null, "\t"))
	await rename(buildingPath, finalPath)
}

/**
 * Parse a response body as JSON, throwing an error that NAMES the URL on failure. Used both on a fresh fetch (BEFORE
 * caching — see {@linkcode fetchAndCache}) and on a cache hit, so a 200 with a non-JSON body (SEC occasionally serves an
 * HTML error page with a 200 status) is caught at the same seam either way and never silently returns garbage.
 */
function parseJSONBody<T>(body: string, url: URL): T {
	try {
		return JSON.parse(body) as T
	} catch (error) {
		throw new Error(`SEC EDGAR response body is not valid JSON (${url})`, { cause: error })
	}
}

/**
 * A SEC EDGAR request that reached an HTTP response (as opposed to a network error — see {@linkcode fetchFresh}),
 * carrying the fields a caller needs to branch programmatically instead of regexing {@linkcode Error.message}: tasks 6-8
 * need "404 → skip this CIK", "403 → abort the whole run", "exhausted 429/5xx → requeue for later" — all three
 * decisions turn on `status` and `retryable`, not on message text. `message` stays purely human-facing.
 */
export class SECRequestError extends Error {
	override readonly name = "SECRequestError"
	/**
	 * The HTTP status code that produced this error.
	 */
	readonly status: number
	/**
	 * The request URL, as a string (mirrors {@linkcode Error.message} carrying it too, but structured).
	 */
	readonly url: string
	/**
	 * Whether THIS CLASS of failure is worth retrying in general (e.g. a later re-run, or a caller's own requeue) —
	 * `true` for 429/5xx (even once this client's own bounded attempts are exhausted: the caller's requeue is a NEW,
	 * separate attempt budget), `false` for 403/404/other non-transient statuses.
	 */
	readonly retryable: boolean

	constructor(message: string, options: { status: number; url: string; retryable: boolean }) {
		super(message)
		this.status = options.status
		this.url = options.url
		this.retryable = options.retryable
	}
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
 * A hard ceiling on how long a single retry wait is ever allowed to be, REGARDLESS of what a server-supplied
 * `Retry-After` asks for. Honoring `Retry-After` (see {@linkcode parseRetryAfterMs}) is the right side of SEC's
 * fair-access policy, but an unbounded honor-anything policy would let a pathological (or misconfigured) server hang a
 * bulk crawl for hours; 60s is generous for anything SEC's rate limiter itself would plausibly ask for.
 */
const MAX_RETRY_AFTER_MS = 60_000

/**
 * Parse a response's `Retry-After` header as whole seconds (the form SEC's rate limiter sends), clamped to
 * {@linkcode MAX_RETRY_AFTER_MS}. Returns `null` when the header is absent or isn't a non-negative number — falling
 * back to this client's own exponential backoff is safer than guessing at the HTTP-date form, which isn't what a rate
 * limiter (as opposed to a `Retry-After` on a redirect or maintenance page) sends in practice.
 */
function parseRetryAfterMs(response: Response): number | null {
	const header = response.headers.get("Retry-After")

	if (!header) return null

	const seconds = Number(header)

	if (!Number.isFinite(seconds) || seconds < 0) return null

	return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
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
	 * `globalThis.fetch`. No test in `sec-client.test.ts` performs a live network call; every test there supplies a stub
	 * here (decision 5).
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
	 * Total attempts (including the first) before giving up on a 429/5xx or a network error. Default 3 — a STATED
	 * CEILING, not "until it works." Exhausting this rethrows the last transient error. Never applies to a 403, which
	 * fails immediately on the first attempt (see the file header).
	 */
	maxAttempts?: number
	/**
	 * Base delay for the exponential backoff between retry attempts, in milliseconds. Attempt `n`'s wait is
	 * `baseRetryDelayMs * 2^(n-1)`, UNLESS the response carried a `Retry-After` header, which is honored instead (see
	 * {@linkcode parseRetryAfterMs}). Default 500.
	 */
	baseRetryDelayMs?: number
	/**
	 * Per-attempt request timeout, in milliseconds, wired through a real `AbortSignal.timeout` — this is REAL wall-clock
	 * time, not the injectable `clock` above (the platform's `AbortSignal.timeout` doesn't take a time source). A
	 * never-settling `fetchImpl` would otherwise hang `get()` forever; a timed-out attempt is treated as a network error
	 * and retried under the same bounded policy. Default 30s.
	 */
	requestTimeoutMs?: number
}

/**
 * A constructed SEC EDGAR client, as returned by {@linkcode createSECClient}.
 */
export interface SECClient {
	/**
	 * Issue a `GET` request against a full absolute EDGAR URL (on `www.sec.gov` or `data.sec.gov` only — see
	 * {@linkcode assertSECHost}) and parse the JSON response body, subject to the on-disk cache, the token-bucket rate
	 * limiter, and bounded retry on 429/5xx/network-errors (decision 5). Throws immediately (no retry) on a 403 — see the
	 * file header — and a {@linkcode SECRequestError} after `maxAttempts` on a persistent 429/5xx.
	 *
	 * Concurrent calls for the SAME url that both miss the cache share a single in-flight fetch (a "stampede guard") —
	 * see {@linkcode fetchFreshDeduped} inside {@linkcode createSECClient}.
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
	const requestTimeoutMs = options.requestTimeoutMs ?? 30_000
	const bucket = new TokenBucket(options.requestsPerSecond ?? SEC_MAX_REQUESTS_PER_SECOND, clock)

	/**
	 * Issue the actual network request(s) for a cache miss: rate-limited, with bounded retry on 429/5xx AND network
	 * errors (a dropped socket, a DNS blip, or this attempt's own timeout firing). Never consults or writes the cache —
	 * that's {@linkcode fetchAndCache}'s job, and it never happens here.
	 */
	async function fetchFresh(url: URL): Promise<string> {
		let lastError: Error | undefined

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			await bucket.acquire()

			let response: Response

			try {
				// Per the SEC's documented sample headers (https://www.sec.gov/os/accessing-edgar-data): a
				// descriptive User-Agent plus Accept-Encoding. `Host` is also in that sample, but this client
				// spans multiple hosts (www.sec.gov, data.sec.gov) — `fetch` derives Host from the URL itself,
				// and hardcoding one here would break requests to the other host.
				response = await fetchImpl(url, {
					headers: {
						"User-Agent": userAgent,
						"Accept-Encoding": "gzip, deflate",
					},
					signal: AbortSignal.timeout(requestTimeoutMs),
				})
			} catch (error) {
				lastError = new Error(`SEC EDGAR request failed: network error on attempt ${attempt}/${maxAttempts} (${url})`, {
					cause: error,
				})

				if (attempt < maxAttempts) {
					await clock.sleep(baseRetryDelayMs * 2 ** (attempt - 1))
				}

				continue
			}

			if (response.ok) {
				return response.text()
			}

			if (response.status === HTTP_FORBIDDEN) {
				throw new SECRequestError(
					`SEC EDGAR request failed: 403 Forbidden (${url}). A bare 403 from sec.gov means the request did ` +
						`NOT identify itself — it does NOT mean the resource is missing or that this client/IP is ` +
						`blocked. SEC's fair-access policy (https://www.sec.gov/os/accessing-edgar-data) rejects ` +
						`requests without a descriptive "Company Name AdminContact@domain.com" User-Agent. The ` +
						`configured UA was "${userAgent}". This is not retried — retrying a 403 cannot succeed and ` +
						`would only burn the 10 req/s rate budget.`,
					{ status: HTTP_FORBIDDEN, url: url.toString(), retryable: false }
				)
			}

			if (!isRetryableStatus(response.status)) {
				throw new SECRequestError(`SEC EDGAR request failed: ${response.status} ${response.statusText} (${url})`, {
					status: response.status,
					url: url.toString(),
					retryable: false,
				})
			}

			lastError = new SECRequestError(`SEC EDGAR request failed: ${response.status} ${response.statusText} (${url})`, {
				status: response.status,
				url: url.toString(),
				retryable: true,
			})

			if (attempt < maxAttempts) {
				const retryAfterMs = parseRetryAfterMs(response)

				await clock.sleep(retryAfterMs ?? baseRetryDelayMs * 2 ** (attempt - 1))
			}
		}

		throw lastError ?? new Error(`SEC EDGAR request failed after ${maxAttempts} attempts (${url})`)
	}

	/**
	 * Fetch, validate as JSON, and cache — in that order. Validating BEFORE writing the cache is what keeps a 200
	 * carrying a non-JSON body (SEC occasionally serves an HTML error page with a 200 status) from being persisted: if
	 * caching happened first, every future request for that URL would replay the poisoned entry forever for an
	 * `/Archives/` URL (which never expires — see {@linkcode isImmutableArchiveURL}), with no self-healing path short of
	 * hand-deleting a SHA-256-named file.
	 */
	async function fetchAndCache(url: URL): Promise<string> {
		const body = await fetchFresh(url)

		parseJSONBody(body, url)
		await writeCacheEntry(url, body, cacheDir, clock)

		return body
	}

	/**
	 * In-flight fetches, keyed by URL — a "stampede guard." Without this, N concurrent `get()` calls for a URL that isn't
	 * cached yet would each independently fetch (each consuming its own rate-limit token) and each independently write
	 * the cache file. This matters more once the token bucket actually queues correctly (see the
	 * {@linkcode TokenBucket.acquire} concurrency fix above) — before that fix, a fan-out mostly bypassed the limiter
	 * anyway, so a stampede was one symptom among several; after it, concurrent requests genuinely queue, and de-duping
	 * them onto a single real fetch is the difference between N wasted requests and one.
	 */
	const inFlightFetches = new Map<string, Promise<string>>()

	function fetchFreshDeduped(url: URL): Promise<string> {
		const key = url.toString()
		let pending = inFlightFetches.get(key)

		if (!pending) {
			pending = fetchAndCache(url)
			inFlightFetches.set(key, pending)

			pending
				.finally(() => inFlightFetches.delete(key))
				.catch(() => {
					// The cleanup itself can't fail (delete() doesn't throw); this silences the unhandled-rejection
					// warning that `.finally()`'s returned promise would otherwise carry when `pending` rejects —
					// the ACTUAL rejection is still delivered to every caller awaiting `pending` directly.
				})
		}

		return pending
	}

	async function get<T>(input: string | URL): Promise<T> {
		const url = input instanceof URL ? input : new URL(input)

		assertSECHost(url)

		const cachedBody = await readCacheEntry(url, cacheDir, cacheTTLMs, clock)

		if (cachedBody !== null) {
			return parseJSONBody<T>(cachedBody, url)
		}

		const body = await fetchFreshDeduped(url)

		return parseJSONBody<T>(body, url)
	}

	return { get }
}
