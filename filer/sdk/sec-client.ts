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
 *   two review passes:
 *
 *     1. UA fail-fast off `$private.SEC_EDGAR_USER_AGENT`, mirroring `bdc/sdk/client.ts:78-83`.
 *     2. A strict-interval request pacer clamped to <= 10 req/s ({@linkcode SEC_MAX_REQUESTS_PER_SECOND}),
 *        driven by an injectable {@linkcode ClockLike} so tests never sleep on the wall clock. See
 *        {@linkcode RequestPacer} for why this is NOT a token bucket — an earlier, bucket-shaped design
 *        measured 20 grants inside one 1000ms window (2x the ceiling) once idle-then-burst was accounted
 *        for, and a concurrency bug in that design let a whole cohort of waiters through at once.
 *     3. A validated-before-write, atomic (write-then-rename with a per-write-unique temp name — see
 *        {@linkcode writeCacheEntry}), stampede-guarded (per-instance) on-disk cache under
 *        `dataRootPath("sec", "cache")`, keyed by the request URL's SHA-256. Archive documents never
 *        expire; every other endpoint gets a TTL — see {@linkcode isImmutableArchiveURL}.
 *     4. Bounded retry with backoff on 429/5xx, connect failures, and mid-body-transfer failures (a
 *        dropped socket is more common than a 503 for a bulk crawler fetching multi-MB filings) — never
 *        on 403 (see below). Honors a response's `Retry-After` header (numeric-seconds AND HTTP-date
 *        forms), clamped to a sane ceiling, falling back LONG rather than short when the header is
 *        present but unparseable. Every attempt carries a per-request timeout (`AbortSignal`), so a
 *        never-settling `fetchImpl` can't hang `get()` forever.
 *     5. A typed {@linkcode SECRequestError} (`status`/`url`/`retryable`) covering EVERY failure this
 *        client can produce past construction — HTTP statuses (`status` a number), AND connect/timeout/
 *        body-transfer failures and the host-allowlist guard (`status: null`) — so a caller (tasks 6-8)
 *        can branch on `status`/`retryable` instead of regexing a message string, for every failure
 *        class, not just HTTP ones.
 *     6. A host allowlist (`www.sec.gov`, `data.sec.gov`, `sec.gov`, `efts.sec.gov`), https-only — this
 *        is the designated SEC client; it refuses to send the configured UA (a contact address) to an
 *        arbitrary caller-supplied host, or in cleartext.
 *
 *   Unlike `BDCClient.get`, which appends a path onto one shared base URL, {@linkcode SECClient.get}
 *   takes a full absolute URL: EDGAR is served across several hosts, so there's no single base to append
 *   a relative path to. (6) above restricts `get` to exactly those hosts over https.
 *
 *   A bare 403 from sec.gov means "you didn't identify yourself": reproduced by hitting the same URL
 *   with and without a compliant UA — no UA is a 403, a descriptive one is a 200. It does NOT mean the
 *   resource is missing or that this client/IP is blocked, and retrying it would just burn the 10 req/s
 *   budget on a request that can never succeed, so 403 is treated as non-retryable and the thrown error
 *   says all of this explicitly (this project already lost time to the analogous failure mode on an FCC
 *   endpoint — a generic "403 Forbidden" sends a future maintainer down exactly the wrong path).
 *
 *   REDIRECT POLICY — deliberately undocumented-until-now, not implemented: `fetchImpl`'s default
 *   (`globalThis.fetch`) follows redirects automatically, and the host allowlist below is only checked
 *   against the ORIGINAL request URL, not each hop. A redirect from an allowed host to an arbitrary one
 *   would carry the configured UA there unchecked. Accepted for now — EDGAR's public JSON/document
 *   endpoints don't redirect cross-host in normal operation — but a future hardening pass fetching
 *   caller-discovered (as opposed to hardcoded) URLs should set `redirect: "manual"` and re-validate the
 *   `Location` host per hop before following it.
 */

import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { $private } from "@mailwoman/core/env"
import { dataRootPath, sha256Hex } from "@mailwoman/core/utils"

/**
 * A minimal, injectable time source. Every wall-clock-facing part of this client — the pacer's wait and the retry
 * backoff — reads through this seam instead of calling `Date.now()` / `setTimeout` directly, so tests can drive both
 * deterministically without ever sleeping for real. (The per-request timeout is a separate seam — see
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
 * 10 requests/second." {@linkcode RequestPacer} clamps its rate to this regardless of a caller-supplied value, so a
 * misconfigured caller can't accidentally push this client over the policy limit — and, per the pacer's strict-interval
 * design, this IS a hard ceiling on any sliding one-second window, not just a steady-state average (see
 * {@linkcode RequestPacer} for why that distinction matters here).
 */
export const SEC_MAX_REQUESTS_PER_SECOND = 10

/**
 * A strict-interval request pacer: grants are spaced AT LEAST `1000 / rate` ms apart, with NO burst allowance beyond
 * the very first grant. {@linkcode RequestPacer.acquire} resolves immediately for the first call after construction (or
 * after any idle gap), and every call within one interval of the previous grant waits out the remainder of it.
 *
 * WHY NOT A TOKEN BUCKET (this class replaced one — 3b task 5 review round 2): a token bucket with capacity C admits up
 * to `C + rate * 1s` requests within any sliding one-second window — there is NO non-zero capacity that honors a FLAT
 * rate cap, only an average one. The bucket this replaced started full (a one-time startup burst, by design) but ALSO
 * refilled to full after any idle gap, so a fresh burst recurred every time the crawl paused and resumed — measured at
 * 20 grants inside one 1000ms window (2x the ceiling: 10 refilled-during-idle tokens released instantly, plus what
 * accrued during that same window). SEC states a flat rate and actively enforces it, and this client is the foundation
 * every task 6-8 EDGAR call goes through, so the bucket's average-case guarantee wasn't good enough: this pacer holds
 * the FLAT rate exactly, at the cost of the first-call-of-a-burst latency a bucket would have avoided (judged an
 * acceptable trade for a bulk crawler, where nothing depends on early requests finishing faster than 1/rate apart).
 *
 * FAIRNESS (deliberately not addressed): under concurrent contention (N callers racing `acquire()` in the same
 * synchronous turn), grants are issued in whatever order the synchronous reservation happens to run in — JS's
 * single-threaded execution order for that turn, not necessarily the callers' own logical arrival order across
 * independent call sites. This never affects the RATE (every grant is still exactly `1000 / rate` ms after the last, so
 * the cap is never exceeded), only which specific caller waits how long under backlog. A caller needing FIFO fairness
 * under contention would need a real queue on top of this; nothing in this client's own use (tasks 6-8, none of which
 * have a latency-sensitive ordering requirement between concurrent requests) needs it.
 */
export class RequestPacer {
	readonly #intervalMs: number
	readonly #clock: ClockLike
	#nextGrantAt: number

	/**
	 * @param ratePerSecond Desired requests/second. Clamped to `[1, SEC_MAX_REQUESTS_PER_SECOND]` — never more than the
	 *   policy ceiling, never less than 1 (a 0-interval pacer would never actually pace).
	 * @param clock Time source. Defaults to {@linkcode systemClock}.
	 */
	constructor(ratePerSecond: number, clock: ClockLike = systemClock) {
		const clampedRate = Math.max(1, Math.min(ratePerSecond, SEC_MAX_REQUESTS_PER_SECOND))

		this.#intervalMs = 1000 / clampedRate
		this.#clock = clock
		this.#nextGrantAt = clock.now()
	}

	/**
	 * Resolve once this call's turn comes up: immediately for the first call (or after any idle gap), or exactly `1000 /
	 * rate` ms after the previous grant otherwise.
	 *
	 * The grant time is reserved SYNCHRONOUSLY, before any `await` — `#nextGrantAt` is read AND bumped in the same
	 * synchronous step that computes this call's own wait. This is load-bearing, not cosmetic: moving the `#nextGrantAt`
	 * update to after the `await` (i.e. "compute the wait, sleep, then update state") reopens the exact concurrency bug
	 * this pacer replaced a token bucket to fix — N callers invoked in the same synchronous turn would all read the SAME
	 * stale `#nextGrantAt` before any of them updates it, compute the SAME wait, and all be released together instead of
	 * one interval apart. (Mutation-proved: moving the update after the `await` fails the concurrency regression test
	 * below.)
	 *
	 * `Math.max(#nextGrantAt, now)` is equally load-bearing: without it, a long idle gap leaves `#nextGrantAt` stuck in
	 * the past, and every call after the idle would compute a negative/zero wait forever (the increment-by-one-interval
	 * never catches up to a `now` that's run far ahead) — pacing would silently stop working after any idle period. (Also
	 * mutation-proved — see the "does not accumulate a burst backlog after an idle period" test.)
	 */
	async acquire(): Promise<void> {
		const now = this.#clock.now()
		const grantAt = Math.max(this.#nextGrantAt, now)

		this.#nextGrantAt = grantAt + this.#intervalMs

		const waitMs = grantAt - now

		if (waitMs > 0) {
			await this.#clock.sleep(Math.ceil(waitMs))
		}
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
 * The only hosts this client will ever send a request to. `get()` refuses (before any cache/rate-limit/ network
 * activity) a URL on any other host, or any non-https scheme — this is the designated SEC EDGAR client, and its
 * configured User-Agent carries a real contact address; sending that anywhere a caller happens to point it (or in
 * cleartext) would leak it outside SEC's fair-access program for no benefit.
 *
 * `sec.gov` (the apex) and `efts.sec.gov` (EDGAR full-text search — task 8's Exhibit 21 discovery path) are included
 * alongside the two hosts decision 5 originally verified. Matching is EXACT (a `Set` lookup on `url.hostname`), not a
 * suffix check — `www.sec.gov.attacker.example` must NOT match, and an `.endsWith(".sec.gov")`-style check would let
 * it. `url.hostname` (from the WHATWG URL parser) already normalizes case, strips userinfo, and
 * percent/punycode-decodes — no extra handling needed for those.
 */
const SEC_ALLOWED_HOSTS = new Set(["www.sec.gov", "data.sec.gov", "sec.gov", "efts.sec.gov"])

function assertSECHost(url: URL): void {
	if (url.protocol !== "https:") {
		throw new SECRequestError(
			`createSECClient: refusing to request "${url}" over ${url.protocol.replace(":", "")} — this client only ` +
				"sends requests over https, so the configured User-Agent (a contact address) is never sent in cleartext.",
			{ status: null, url: url.toString(), retryable: false }
		)
	}

	if (!SEC_ALLOWED_HOSTS.has(url.hostname)) {
		throw new SECRequestError(
			`createSECClient: refusing to request "${url}" — this client only sends requests to SEC EDGAR hosts ` +
				`(${[...SEC_ALLOWED_HOSTS].join(", ")}). Sending the configured User-Agent (a contact address) to an ` +
				"arbitrary caller-supplied host would leak it outside SEC's fair-access program.",
			{ status: null, url: url.toString(), retryable: false }
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
 * build-then-move convention: a reader never observes a half-written entry, and a crash mid-write leaves only an
 * orphaned temp file rather than a corrupt cache entry.
 *
 * The temp name is per-write UNIQUE (`randomUUID()`), not derived from the URL. An earlier version used a deterministic
 * `${finalPath}.building` name — fine for a single writer, but TWO `createSECClient()` instances (or two processes)
 * sharing one `cacheDir` and racing to write the SAME url would both target the SAME temp path: the first `rename()`
 * moves it away, and the second gets a raw, unretried `ENOENT` for a response that had already succeeded (review round
 * 2, reproduced 6/6 with two client instances; with large bodies, the concurrent writes to the shared temp path also
 * produced a corrupt-but-parseable entry in 2/10 rounds — both writers' bytes interleaved — which would never expire
 * under `/Archives/`). A unique temp name per write makes the two writes independent: each write is a distinct file, so
 * neither can observe or corrupt the other's, and whichever `rename()` runs second simply (atomically) replaces the
 * first's result — no ENOENT, no interleaving, regardless of body size or write ordering. `process.pid` isn't included
 * — `randomUUID()`'s 122 bits of randomness already make a collision between two temp names astronomically unlikely on
 * its own, and this avoids adding a `process.*` global read to a file that otherwise has none (this repo lints
 * `process.env` reads; `process.pid` isn't covered by that rule, but there's no reason to reach for it when it buys
 * nothing extra here).
 */
async function writeCacheEntry(url: URL, body: string, cacheDir: string | undefined, clock: ClockLike): Promise<void> {
	const entry: SECCacheEntry = { url: url.toString(), fetchedAt: clock.now(), body }
	const finalPath = cacheFilePath(url, cacheDir)
	const buildingPath = `${finalPath}.${randomUUID()}.building`

	await mkdir(resolveCacheDir(cacheDir), { recursive: true })
	await writeFile(buildingPath, JSON.stringify(entry, null, "\t"))
	await rename(buildingPath, finalPath)
}

/**
 * Parse a response body as JSON, throwing an error that NAMES the URL on failure. Used both on a fresh fetch (BEFORE
 * caching — see {@linkcode fetchAndCache}) and on a cache hit, so a 200 with a non-JSON body (SEC occasionally serves an
 * HTML error page with a 200 status) is caught at the same seam either way and never silently returns garbage. Stays a
 * plain `Error` (not {@linkcode SECRequestError}) — a bad body isn't a network-class failure a caller would want to
 * branch on/retry the same way; retrying an unchanged bad response can't help.
 */
function parseJSONBody<T>(body: string, url: URL): T {
	try {
		return JSON.parse(body) as T
	} catch (error) {
		throw new Error(`SEC EDGAR response body is not valid JSON (${url})`, { cause: error })
	}
}

/**
 * Every failure this client can produce past construction, carrying the fields a caller needs to branch
 * programmatically instead of regexing {@linkcode Error.message}: tasks 6-8 need "404 → skip this CIK", "403 → abort the
 * whole run", "exhausted 429/5xx OR a persistent connect/timeout failure → requeue for later" — all three decisions
 * turn on `status` and `retryable`, not on message text.
 *
 * `status` is `null` for failures that never reached an HTTP response at all: a connect failure, a timed-out attempt
 * (see `CreateSECClientOptions.requestTimeoutMs`), a body read that dropped mid- transfer, or the pre-flight
 * host-allowlist rejection ({@linkcode assertSECHost}). Review round 2 found this taxonomy only covering HTTP statuses
 * left every one of those — the MOST common outcome for a bulk crawler fetching multi-MB filings, per review — as a
 * bare `Error`, silently defeating the natural caller pattern `if (e instanceof SECRequestError && e.retryable)
 * requeue()`. `message` stays purely human-facing either way.
 */
export class SECRequestError extends Error {
	override readonly name = "SECRequestError"
	/**
	 * The HTTP status code that produced this error, or `null` when no HTTP response was ever reached (a connect failure,
	 * a timeout, a mid-body-transfer drop, or the host-allowlist guard).
	 */
	readonly status: number | null
	/**
	 * The request URL, as a string (mirrors {@linkcode Error.message} carrying it too, but structured).
	 */
	readonly url: string
	/**
	 * Whether THIS CLASS of failure is worth retrying in general (e.g. a later re-run, or a caller's own requeue) —
	 * `true` for 429/5xx and every `status: null` network-class failure (even once this client's own bounded attempts are
	 * exhausted: a caller's requeue is a NEW, separate attempt budget), `false` for 403/404/other non-transient statuses
	 * and the host-allowlist guard (retrying with the SAME url can only ever fail identically).
	 */
	readonly retryable: boolean

	constructor(message: string, options: { status: number | null; url: string; retryable: boolean }) {
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
 * bulk crawl for hours; 60s is generous for anything SEC's rate limiter itself would plausibly ask for. Also the
 * fallback used when `Retry-After` is PRESENT but unparseable (see below) — a malformed header is still the server
 * asking us to back off, and guessing LONG is the safe failure mode; guessing short (the exponential default) risks
 * hammering a server that explicitly asked for space.
 */
const MAX_RETRY_AFTER_MS = 60_000

/**
 * RFC 9110 §10.2.3: `Retry-After` is either `delay-seconds` (`1*DIGIT` — one or more ASCII digits, no sign, no decimal
 * point, no hex) or an HTTP-date. `Number("0x10")` and `Number("1.5")` both parse as valid JS numbers but are NOT valid
 * `delay-seconds`, so the numeric branch matches the RFC grammar directly instead of delegating to `Number()`.
 */
const RETRY_AFTER_DELAY_SECONDS_PATTERN = /^\d+$/

/**
 * A necessary (not sufficient) pre-check before trusting `Date.parse` on the HTTP-date branch: `Date.parse` is FAR more
 * lenient than RFC 9110's HTTP-date grammar and will happily parse plausible- looking garbage — `Date.parse("1.5")`
 * returns a valid timestamp (~Jan 2001, some locale-ish `M.D` reading), which very nearly slipped a bare
 * fractional-seconds typo through as an accepted HTTP-date instead of falling back to the long ceiling. Every valid RFC
 * 9110 HTTP-date form (the preferred IMF-fixdate AND the obsolete RFC 850 form) ends in the literal `GMT`; requiring
 * that suffix rejects `Date.parse`'s stray non-date parses without needing a full HTTP-date grammar implementation.
 */
const HTTP_DATE_SUFFIX_PATTERN = /GMT$/

/**
 * Parse a response's `Retry-After` header — numeric `delay-seconds` or an HTTP-date, per RFC 9110 — into a clamped wait
 * duration in ms.
 *
 * Returns `null` only when the header is ABSENT (the caller should fall back to its own exponential backoff in that
 * case). When the header IS present, this always returns a number: the parsed (and
 * {@linkcode MAX_RETRY_AFTER_MS}-clamped) value on success, or `MAX_RETRY_AFTER_MS` itself when the value is present
 * but matches neither valid form — see the constant's docstring for why unparseable fails open toward caution rather
 * than speed.
 *
 * The HTTP-date branch compares against REAL wall-clock time (`Date.now()`), not the injectable {@linkcode ClockLike} —
 * an HTTP-date is an absolute calendar timestamp, which only means something relative to the actual current time, so
 * there's no way to route this comparison through a virtual clock the way the rest of this client's timing does.
 */
function parseRetryAfterMs(response: Response): number | null {
	const header = response.headers.get("Retry-After")

	if (!header) return null

	const trimmed = header.trim()

	if (RETRY_AFTER_DELAY_SECONDS_PATTERN.test(trimmed)) {
		return Math.min(Number(trimmed) * 1000, MAX_RETRY_AFTER_MS)
	}

	if (HTTP_DATE_SUFFIX_PATTERN.test(trimmed)) {
		const dateMs = Date.parse(trimmed)

		if (!Number.isNaN(dateMs)) {
			return Math.min(Math.max(dateMs - Date.now(), 0), MAX_RETRY_AFTER_MS)
		}
	}

	return MAX_RETRY_AFTER_MS
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
	 * {@linkcode RequestPacer}. Defaults to {@linkcode SEC_MAX_REQUESTS_PER_SECOND}.
	 */
	requestsPerSecond?: number
	/**
	 * Time source powering the pacer's wait and the retry backoff. Defaults to {@linkcode systemClock}. Tests inject a
	 * fake clock so rate-limit and retry behavior are deterministic and fast — no wall-clock sleeps in the suite.
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
	 * Total attempts (including the first) before giving up on a 429/5xx or a network-class failure (connect, timeout, or
	 * mid-body-transfer). Default 3 — a STATED CEILING, not "until it works." Exhausting this rethrows the last transient
	 * error. Never applies to a 403, which fails immediately on the first attempt (see the file header).
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
	 * time, not the injectable `clock` above (the platform's `AbortSignal.timeout` doesn't take a time source). Covers
	 * the ENTIRE attempt, including the body read — a document slower than this to fully transfer aborts and retries,
	 * same as a connect failure. Default 30s.
	 */
	requestTimeoutMs?: number
}

/**
 * A constructed SEC EDGAR client, as returned by {@linkcode createSECClient}.
 */
export interface SECClient {
	/**
	 * Issue a `GET` request against a full absolute EDGAR URL (https, on an allowed host only — see
	 * {@linkcode assertSECHost}) and return the parsed JSON response body, subject to the on-disk cache, the request
	 * pacer, and bounded retry on 429/5xx/network-class failures (decision 5). Throws immediately (no retry) on a 403 or
	 * a pre-flight host/scheme rejection — both a {@linkcode SECRequestError} — and a {@linkcode SECRequestError} after
	 * `maxAttempts` on a persistent 429/5xx or network-class failure.
	 *
	 * Concurrent calls for the SAME url that both miss the cache, on the SAME client instance, share a single in-flight
	 * fetch (a "stampede guard") — see {@linkcode fetchFreshDeduped} inside {@linkcode createSECClient}. This does NOT
	 * cover two separate client instances (or processes) sharing one `cacheDir`; {@linkcode writeCacheEntry}'s
	 * per-write-unique temp file is what makes THAT case safe (no corruption, no thrown error), just not de-duplicated.
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
	const pacer = new RequestPacer(options.requestsPerSecond ?? SEC_MAX_REQUESTS_PER_SECOND, clock)

	/**
	 * Issue the actual network request(s) for a cache miss: paced, with bounded retry on 429/5xx AND network-class
	 * failures (a dropped connection, a DNS blip, this attempt's own timeout firing, or a mid-body-transfer drop). The
	 * body read (`response.text()`) happens INSIDE the same try/catch as the fetch call itself — review round 2 found it
	 * living outside, so a 200 whose body read rejected (the `AbortSignal.timeout` stays attached through the read, and
	 * undici raises `TypeError: terminated` on a mid-transfer drop) got one attempt and a plain, unretried `TypeError` —
	 * exactly the failure mode this retry loop exists for, and the COMMON one for tasks 6-8's multi-MB filing fetches.
	 * Never consults or writes the cache — that's {@linkcode fetchAndCache}'s job, and it never happens here.
	 */
	async function fetchFresh(url: URL): Promise<string> {
		let lastError: Error | undefined

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			await pacer.acquire()

			let response: Response

			try {
				// Per the SEC's documented sample headers (https://www.sec.gov/os/accessing-edgar-data): a
				// descriptive User-Agent plus Accept-Encoding. `Host` is also in that sample, but this client
				// spans multiple hosts — `fetch` derives Host from the URL itself, and hardcoding one here
				// would break requests to the others.
				response = await fetchImpl(url, {
					headers: {
						"User-Agent": userAgent,
						"Accept-Encoding": "gzip, deflate",
					},
					signal: AbortSignal.timeout(requestTimeoutMs),
				})

				if (response.ok) {
					return await response.text()
				}
			} catch (error) {
				lastError = new SECRequestError(
					`SEC EDGAR request failed: network error on attempt ${attempt}/${maxAttempts} (${url}): ${
						error instanceof Error ? error.message : String(error)
					}`,
					{ status: null, url: url.toString(), retryable: true }
				)

				if (attempt < maxAttempts) {
					await clock.sleep(baseRetryDelayMs * 2 ** (attempt - 1))
				}

				continue
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
	 * Fetch, validate as JSON, cache, and return the ALREADY-PARSED value — in that order. Validating BEFORE writing the
	 * cache is what keeps a 200 carrying a non-JSON body (SEC occasionally serves an HTML error page with a 200 status)
	 * from being persisted: if caching happened first, every future request for that URL would replay the poisoned entry
	 * forever for an `/Archives/` URL (which never expires — see {@linkcode isImmutableArchiveURL}), with no self-healing
	 * path short of hand-deleting a SHA-256-named file. Returning the parsed value (not the raw string) means
	 * {@linkcode get} never has to `JSON.parse` a freshly-fetched body a second time — review round 2 found the
	 * double-parse; the raw `body` string is still what gets written to disk, since the cache format stores the body
	 * verbatim.
	 */
	async function fetchAndCache(url: URL): Promise<unknown> {
		const body = await fetchFresh(url)
		const parsed = parseJSONBody<unknown>(body, url)

		await writeCacheEntry(url, body, cacheDir, clock)

		return parsed
	}

	/**
	 * In-flight fetches, keyed by URL — a "stampede guard" for concurrent misses on THIS client instance. Without this, N
	 * concurrent `get()` calls for a URL that isn't cached yet would each independently fetch (each consuming its own
	 * pacer slot) and each independently write the cache file. This does NOT cover two separate `createSECClient()`
	 * instances (or two processes) sharing one `cacheDir` — this map is per-instance state — which is exactly the
	 * scenario {@linkcode writeCacheEntry}'s per-write-unique temp file protects against instead (safe, just not
	 * de-duplicated, in that case).
	 */
	const inFlightFetches = new Map<string, Promise<unknown>>()

	function fetchFreshDeduped(url: URL): Promise<unknown> {
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

		return (await fetchFreshDeduped(url)) as T
	}

	return { get }
}
