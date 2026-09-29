/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file SEC edgar http client, built on {@linkcode APIClient} (3b decision 5).
 *
 *   SEC's fair-access policy (https://www.sec.gov/os/accessing-edgar-data, verified against source
 *   2026-07-31) declares a max request rate of 10/second and asks for a descriptive `User-Agent`
 *   naming a company + contact address, plus `Accept-Encoding: gzip, deflate`.
 *
 *   `@mailwoman/core/api` provides the shared pacer, retry loop, on-disk cache and error type.
 *   `bdc/sdk/client.ts` uses the same general HTTP-client implementation. This file provides the
 *   SEC-specific behavior:
 *
 *     1. UA fail-fast off `$private.SEC_EDGAR_USER_AGENT` — a silently-UA-less client just 403s on
 *        first use. Constructor validation reports a missing UA before any request starts.
 *     2. The 10 req/s ceiling, expressed as {@linkcode APIClientConfig.minRequestIntervalMs} and
 *        clamped regardless of a caller-supplied rate, so a misconfigured caller cannot push past the
 *        policy limit. Not a token bucket: capacity C admits `C + rate * 1s` inside a sliding second,
 *        so no non-zero capacity honors a flat cap — see `core/api/pacer.ts`.
 *     3. The immutable-archive-vs-TTL cache rule — see {@linkcode isImmutableArchiveURL}.
 *     4. A host allowlist, https-only. This is the designated SEC client. it refuses to send the
 *        configured UA (a real contact address) to an arbitrary caller-supplied host, or in cleartext.
 *     5. The 403 explanation. A bare 403 from sec.gov means "you didn't identify yourself":
 *        reproduced by hitting the same URL with and without a compliant UA — no UA is a 403, a
 *        descriptive one is a 200. It does not mean the resource is missing or that this client/IP is
 *        blocked. Retrying it would burn the 10 req/s budget. The 403 is non-retryable
 *        (`core/api/retry.ts`) and the thrown error says all of this explicitly. This project already
 *        lost a debugging cycle to a generic "403 Forbidden" on an FCC endpoint.
 *
 *   document path (a prerequisite the migration review flagged as `m3`/`I2`, folded into Task
 *   7's commit because Exhibit 21 parsing is the first consumer). {@linkcode SECClient.get} is JSON-only —
 *   `responseType: "json"` plus a cache `validate` predicate that required an object body — so it could
 *   never fetch a filing document (a 10-K, an Exhibit 21, any `/Archives/` html/text page). {@linkcode
 *   SECClient.getDocument} is the raw-text sibling: same client, same pacing limit, same host allowlist, same
 *   retry policy, same {@linkcode ResourceError} mapping — the only difference is a per-request `responseType:
 *   "text"` override makes Axios return the body as-is. Axios skips `JSON.parse`. The on-disk
 *   cache is keyed by URL alone (method/URL/params/body — never `responseType`), so a document fetched once
 *   is served from the same cache entry on a later `getDocument` call for that URL; `get`/`getDocument` are
 *   never called against the same URL in practice (JSON endpoints vs. `/Archives/` documents are disjoint
 *   host paths), so this sharing is never observed to disagree. The cache's `validate` predicate (below) was
 *   widened to admit a non-empty string body alongside the existing non-null-object rule, so a document isn't
 *   rejected for not being JSON while a truncated/empty body (either shape) still is.
 *
 *   error interface. Every failure past construction is a {@linkcode ResourceError} — no bespoke error
 *   class — so tasks 6-8 branch on `status` plus {@linkcode isTransientResourceError}, never on message
 *   prose:
 *
 *   | Outcome                              | Caller action | Test                                     |
 *   | ------------------------------------ | ------------- | ---------------------------------------- |
 *   | 404                                  | skip filing   | `error.status === 404`                   |
 *   | 403                                  | abort the run | `error.status === 403`                   |
 *   | exhausted 429/5xx                    | requeue       | `isTransientResourceError(error)`        |
 *   | exhausted network/timeout            | requeue       | `isTransientResourceError(error)`        |
 *   | disallowed host, undecodable body    | programmer bug| `isTransientResourceError(error)` is false |
 *
 *   redirect policy: Axios follows redirects automatically. The host allowlist checks the original
 *   request URL and skips each later hop. A redirect from an allowed
 *   host to an arbitrary one would carry the configured UA there unchecked. Accepted for now — edgar's
 *   public JSON/document endpoints don't redirect cross-host in normal operation — but a future
 *   hardening pass fetching caller-discovered (as opposed to hardcoded) URLs should set
 *   `maxRedirects: 0` and re-validate the `Location` host per hop before following it.
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
import { ResourceError } from "@mailwoman/core/errors"
import type { PathBuilderLike } from "path-ts"

import { $private } from "#env"

// Re-exported so a caller branching on this client's failures needs exactly one import.

/**
 * The SEC fair-access policy's stated ceiling (https://www.sec.gov/os/accessing-edgar-data):
 * "Current max request rate: 10 requests/second." {@linkcode createSECClient}
 * clamps to this regardless of a caller-supplied value.
 *
 * The underlying pacer uses a strict interval instead of a bucket, so this is a hard
 * ceiling on the schedule rather than a steady-state average.
 */
export const SEC_MAX_REQUESTS_PER_SECOND = 10

/**
 * What this client actually paces at — deliberately one below {@linkcode SEC_MAX_REQUESTS_PER_SECOND}.
 *
 * A grant schedule at the ceiling has zero slack.
 * SEC measures arriving requests rather than the grant schedule.
 *
 * Measured end-to-end through {@linkcode createSECClient} on real timers, a 40-call
 * fan-out at 10/s produced **11 requests inside one sliding second on 3 of 3 runs**:
 * the grants themselves are spaced correctly, but the continuation that issues the request
 * lands 0-2 ms late and tips one grant across the boundary (the preceding second then holds 9).
 *
 * A true sliding-window limiter counts this as a violation.
 * The grant schedule remains arithmetically compliant.
 * This mismatch makes a failed block difficult to debug.
 *
 * One request per second of headroom costs ~10% throughput on a crawl that is already cache-heavy.
 * The extra headroom keeps arrivals inside the published limit when the event loop runs late.
 *
 * `SEC_MAX_REQUESTS_PER_SECOND` remains the clamp — a caller may ask for anything
 * up to it — but the default is this.
 *
 * Raise it only with a measurement showing the arrival-time distribution stays
 * under 10/s rather than merely the grant times.
 *
 * The interval must also be an integer number of milliseconds.
 * This constant's first value did not meet that requirement.
 *
 * `1000 / 9` is `111.111…`.
 * A fractional interval puts the 10th grant at exactly 1000.0 ms after the first.
 *
 * So sub-millisecond jitter tips a 10th arrival into the window every time, measured 5/5 runs.
 * {@linkcode createSECClient} therefore ceils the interval (`Math.ceil(1000 / 9)` = 112 ms),
 * which moves the 10th grant to 1008 ms and costs 0.8% throughput.
 *
 * Measured after the ceil: 9 arrivals per sliding second, 3/3 runs.
 * Apply the same treatment to future rates that do not divide 1000 evenly.
 *
 * The single `Math.ceil` call makes that policy explicit.
 */
export const SEC_DEFAULT_REQUESTS_PER_SECOND = 9

/**
 * Milliseconds in a second — the numerator when turning a requests/second rate into a pacing interval.
 */
const MS_PER_SECOND = 1000

/**
 * How long a cached entry for a mutable endpoint stays fresh by default. 24h:
 * generous enough to avoid re-hammering the submissions index/ticker map on every run,
 * short enough that a day-old crosswalk build still notices a company's newest 10-K.
 */
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * The TTL applied to an immutable archive document — a century rather than `Infinity`.
 *
 * `Infinity` is the obvious spelling of "never expires" and the wrong one:
 * `JSON.stringify(Infinity)` is `"null"`, and `null` reads back as `0` in the cache
 * interceptor's `createdAt + ttl < Date.now()` expiry test, so a "permanent" entry would
 * round-trip through disk into one that is expired the instant it is read.
 * `buildDiskStorage` refuses a non-finite TTL outright for exactly this reason.
 */
const PERMANENT_CACHE_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000

/**
 * The status a request that failed to identify itself comes back as.
 *
 * See the file header — this one gets its own explanation rather than a generic "Forbidden".
 */
const HTTP_FORBIDDEN = 403

/**
 * The lowest success status and the first status past the success range.
 *
 * The window a response must land in before its body is worth caching.
 *
 * The interceptor's default admits 3xx responses.
 * This interval excludes them.
 */
const HTTP_OK = 200
const HTTP_MULTIPLE_CHOICES = 300

const SEC_ARCHIVE_PATH_PATTERN = /^\/Archives\/edgar\/data\//

/**
 * Edgar archive documents (10-Ks, Exhibit 21 subsidiary lists and every other filing exhibit)
 * live at a path of this shape once submitted,
 * e.g. `https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/aapl-20230930.htm`.
 *
 * SEC does not revise a filed document in place.
 * A correction is a new filing at a new path — so a document fetched today
 * reads identically a year from now.
 *
 * An effectively permanent cache for these documents saves a network round-trip
 * and rate-limit budget on every rerun, with zero staleness risk.
 *
 * Every other endpoint this client is asked to reach — the submissions index
 * (`/submissions/CIK##########.json`), the ticker map (`/files/company_tickers.json`), and the classic
 * browse-edgar CGI — is a live index that changes as new filings land or tickers get reassigned.
 * A permanent cache for those indexes would be the wrong choice
 * (a stale submissions index would silently hide a company's newest 10-K from tasks 6-8),
 * so entries for URLs this returns `false` for expire after `cacheTTLMs` instead.
 */
export function isImmutableArchiveURL(url: URL): boolean {
	return SEC_ARCHIVE_PATH_PATTERN.test(url.pathname)
}

/**
 * The only hosts this client will ever send a request to. {@linkcode SECClient.get} refuses
 * (before any cache/rate-limit/network activity) a URL on any other host, or any non-https scheme.
 *
 * This is the designated SEC edgar client.
 * Its configured User-Agent carries a real contact address.
 *
 * A caller-supplied host or a cleartext connection would expose the User-Agent
 * outside SEC's fair-access program without benefit.
 *
 * `sec.gov` (the apex) and `efts.sec.gov` (edgar full-text search — the Exhibit 21 discovery path)
 * are included alongside the two hosts decision 5 names.
 * Matching is exact (a `Set` lookup on `url.hostname`), not a suffix check.
 *
 * Exact hostname matching rejects `www.sec.gov.attacker.example`.
 * An `.endsWith(".sec.gov")`-style check would accept it.
 *
 * The whatwg URL parser lower-cases `url.hostname`, strips userinfo and decodes percent and punycode.
 * Those inputs therefore need no extra handling.
 */
const SEC_ALLOWED_HOSTS = new Set(["www.sec.gov", "data.sec.gov", "sec.gov", "efts.sec.gov"])

/**
 * Reject a URL this client must not send its User-Agent to.
 *
 * @throws A {@linkcode ResourceError} whose URN kind is `request` — never transient,
 * because re-issuing the identical URL can only fail identically.
 */
function assertSECHost(url: URL): void {
	assertAllowedHost(url, {
		allowed: SEC_ALLOWED_HOSTS,
		scope: "createSECClient",
		clientName: "sec",
		hostsDescription: `SEC EDGAR hosts (${[...SEC_ALLOWED_HOSTS].join(", ")})`,
		hostNote:
			"Sending the configured User-Agent (a contact address) to an arbitrary caller-supplied host would leak it " +
			"outside SEC's fair-access program.",
	})
}

/**
 * Options for {@linkcode createSECClient}.
 */
export interface CreateSECClientOptions {
	/**
	 * SEC edgar fair-access User-Agent, e.g. `"Nirrius, LLC support@nirri.us"`.
	 *
	 * Defaults to `$private.SEC_EDGAR_USER_AGENT` when omitted.
	 */
	userAgent?: string
	/**
	 * Desired requests/second.
	 *
	 * Clamped to `[1, SEC_MAX_REQUESTS_PER_SECOND]` regardless of what's passed.
	 * Defaults to {@linkcode SEC_DEFAULT_REQUESTS_PER_SECOND}, which is one below
	 * the policy ceiling on purpose.
	 * See that constant for the measurement behind it.
	 */
	requestsPerSecond?: number
	/**
	 * Time source powering the pacer and the retry backoff.
	 *
	 * Defaults to the system clock.
	 * Tests inject a fake clock so rate-limit and retry behavior are deterministic
	 * and fast — no wall-clock sleeps in the suite.
	 */
	clock?: ClockLike
	/**
	 * On-disk cache root.
	 *
	 * Defaults to `dataRootPath("sec", "cache")`, resolved once at construction (the standalone client
	 * re-resolved it per request. Construct the client after setting `$MAILWOMAN_DATA_ROOT` instead).
	 */
	cacheDir?: PathBuilderLike
	/**
	 * How long a cached entry for a mutable endpoint (anything {@linkcode isImmutableArchiveURL}
	 * returns `false` for) stays fresh, in milliseconds.
	 *
	 * Archive documents ignore this entirely.
	 */
	cacheTTLMs?: number
	/**
	 * Total attempts (including the first) before giving up on a 429/5xx
	 * or a network-class failure (connect, timeout, or mid-body-transfer).
	 *
	 * A stated ceiling rather than "until it works".
	 * Never applies to a 403.
	 */
	maxAttempts?: number
	/**
	 * Base delay for the exponential backoff between retry attempts, in milliseconds.
	 *
	 * Attempt `n`'s wait is `baseRetryDelayMs * 2^(n-1)`, unless the response carried
	 * A `Retry-After` header overrides this delay.
	 */
	baseRetryDelayMs?: number
	/**
	 * Per-attempt request timeout, in milliseconds.
	 *
	 * Covers the whole attempt including the body read — a document slower than this
	 * to transfer aborts and retries, same as a connect failure.
	 */
	requestTimeoutMs?: number
	/**
	 * Axios overrides, merged over this client's own defaults.
	 *
	 * The test injection point: every test in `sec-client.test.ts` passes an `adapter` here,
	 * so no test ever performs a live network call (decision 5).
	 * A wholesale `headers` override would drop the User-Agent.
	 */
	axios?: APIClientConfig["axios"]
}

/**
 * {@linkcode APIClient} configuration plus the SEC-specific fields
 * {@linkcode SECClient} reads back off `config`.
 */
export interface SECClientConfig extends APIClientConfig {
	/**
	 * The fair-access User-Agent every request carries.
	 *
	 * Included in the 403 explanation so a maintainer can see what was actually sent.
	 */
	userAgent: string
}

/**
 * Rewrite a 403 into an error that tells a maintainer what actually went wrong.
 *
 * A generic "403 Forbidden" reads as "blocked" or "missing" and sends the reader down the wrong path.
 * The real cause is almost always the User-Agent.
 *
 * The URN and status are reconstructed identically, so the caller's `status === 403` branch is unaffected.
 */
function explainForbidden(cause: ResourceError, url: URL, userAgent: string): ResourceError {
	const explained = ResourceError.from(
		HTTP_FORBIDDEN,
		`SEC EDGAR request failed: 403 Forbidden (${url}). A bare 403 from sec.gov means the request did NOT ` +
			`identify itself — it does NOT mean the resource is missing or that this client/IP is blocked. SEC's ` +
			`fair-access policy (https://www.sec.gov/os/accessing-edgar-data) rejects requests without a descriptive ` +
			`"Company Name AdminContact@domain.com" User-Agent. The configured UA was "${userAgent}". This is not ` +
			`retried — retrying a 403 cannot succeed and would only burn the 10 req/s rate budget.`,
		"axios",
		"response",
		"forbidden"
	)

	explained.cause = cause

	return explained
}

/**
 * A SEC edgar client.
 *
 * Constructed via {@linkcode createSECClient}, which resolves the User-Agent and every default.
 */
export class SECClient extends APIClient<SECClientConfig> {
	/**
	 * Issue a `GET` against a full absolute edgar URL (https, on an allowed host only) and return
	 * the parsed JSON body, subject to the on-disk cache, request pacer and bounded retry.
	 *
	 * Takes a full absolute URL rather than a path appended to one base: edgar is served
	 * across several hosts, so there is no single base to append to.
	 *
	 * Concurrent calls for the same URL that both miss the cache share a single in-flight request.
	 * The cache interceptor provides a stampede guard.
	 * The bespoke client had to implement one itself.
	 */
	public async get<T>(input: string | URL): Promise<T> {
		const url = input instanceof URL ? input : new URL(input)

		assertSECHost(url)

		try {
			const response = await this.fetch<T>({ url: url.toString() })

			return response.data
		} catch (error) {
			if (error instanceof ResourceError && error.status === HTTP_FORBIDDEN) {
				throw explainForbidden(error, url, this.config.userAgent)
			}

			throw error
		}
	}

	/**
	 * Issue a `GET` against a full absolute edgar URL and return the RAW response body as text.
	 *
	 * Use this method for filing documents such as 10-Ks and Exhibit 21s. {@linkcode get}
	 * assumes a JSON body in its `responseType: "json"` setting and cache `validate` predicate.
	 *
	 * Same client, same pacing limit, same host allowlist, same retry policy,
	 * same {@linkcode ResourceError} mapping as {@linkcode get} — only a per-request The
	 * `responseType: "text"` override tells Axios to return the body as-is.
	 * Axios does not attempt `JSON.parse` on it (the default `transformResponse` only parses
	 * when `responseType === "json"`; this override is what turns that off for exactly this one call).
	 *
	 * `/Archives/edgar/data/` documents still get the permanent cache TTL
	 * ({@linkcode isImmutableArchiveURL}); the widened cache `validate` predicate below
	 * is what stops that permanent cache from rejecting the non-JSON body.
	 */
	public async getDocument(input: string | URL): Promise<string> {
		const url = input instanceof URL ? input : new URL(input)

		assertSECHost(url)

		try {
			const response = await this.fetch<string>({ url: url.toString(), responseType: "text" })

			return response.data
		} catch (error) {
			if (error instanceof ResourceError && error.status === HTTP_FORBIDDEN) {
				throw explainForbidden(error, url, this.config.userAgent)
			}

			throw error
		}
	}
}

/**
 * The TTL for one response: permanent for an immutable archive document,
 * `mutableTTLMs` for everything else.
 *
 * Structurally typed rather than importing `CacheAxiosResponse`.
 * `filer` deliberately depends on neither `axios` nor `axios-cache-interceptor`,
 * reaching both only through `@mailwoman/core`.
 */
function responseTTL(response: { config: { url?: string } }, mutableTTLMs: number): number {
	const { url } = response.config

	if (!url) return mutableTTLMs

	try {
		return isImmutableArchiveURL(new URL(url)) ? PERMANENT_CACHE_TTL_MS : mutableTTLMs
	} catch {
		return mutableTTLMs
	}
}

/**
 * The cache's `validate` predicate — decides whether a response body is worth
 * persisting at all, before it reaches disk.
 *
 * Two response shapes are worth caching.
 * The same edgar host serves both, depending on the endpoint:
 *
 * - A JSON object/array (every `get<T>` call — the submissions index, the ticker map, `browse-edgar`).
 *   Axios already rejects an unparseable body via `transitional.silentJSONParsing`
 *   (see the `axios` config below), so this is the second check rather than the first.
 *   A decoded body that isn't an object means the upstream served something other than what it claimed.
 * - A non-empty string (every `getDocument` call — a filing document is html/text, never JSON):
 *   admits the body `getDocument`'s `responseType: "text"` override actually produces.
 *   A `typeof === "object"` test alone would reject it outright, since a string is never `typeof "object"`.
 *   `.length > 0` is the truncated/empty guard on this shape.
 *   `getDocument` has no Axios-level parse step to lean on the way the JSON path does,
 *   so this predicate is the only check standing between a truncated/empty document
 *   and a permanent (`/Archives/edgar/data/`) cache entry with no self-healing path
 *   short of hand-deleting a file whose name is its hash.
 *
 * An `/Archives/` entry cached under the permanent TTL has no self-healing path
 * short of hand-deleting a file whose name is its hash.
 * That is why both branches exist instead of one permissive `Boolean(value.data?.data)` check.
 *
 * That would also admit a numeric `0` or a boolean `false` body, neither of
 * which this client's endpoints ever legitimately return.
 */
function isCacheableSECBody(value: { data?: { data?: unknown } }): boolean {
	const body = value.data?.data

	if (typeof body === "string") return body.length > 0

	return typeof body === "object" && body !== null
}

/**
 * Create a SEC edgar http client.
 *
 * See the file header for the full rationale.
 *
 * @throws Immediately, before any request is made, when constructed without an
 * explicit `userAgent` and without `SEC_EDGAR_USER_AGENT` set.
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

	const requestsPerSecond = Math.max(
		1,
		Math.min(options.requestsPerSecond ?? SEC_DEFAULT_REQUESTS_PER_SECOND, SEC_MAX_REQUESTS_PER_SECOND)
	)

	const cacheTTLMs = options.cacheTTLMs ?? DEFAULT_CACHE_TTL_MS

	return new SECClient({
		displayName: "SEC EDGAR",
		userAgent,
		minRequestIntervalMs: Math.ceil(MS_PER_SECOND / requestsPerSecond),
		retry: {
			maxAttempts: options.maxAttempts ?? API_CLIENT_DEFAULTS.maxAttempts,
			baseDelayMs: options.baseRetryDelayMs ?? API_CLIENT_DEFAULTS.baseRetryDelayMs,
		},
		clock: options.clock,
		caching: {
			storage: buildDiskStorage({
				directory: options.cacheDir ?? dataRootPath("sec", "cache"),
				// Validate before writing — see isCacheableSECBody's own docstring for
				// the JSON-object-or- non-empty-string rule.
				// A JSON-object-only rule would reject getDocument's text bodies.
				validate: isCacheableSECBody,
			}),
			ttl: (response) => responseTTL(response, cacheTTLMs),
			// SEC sends its own `Cache-Control`.
			// SEC's header would override the archive-vs-index rule above.
			// That rule is the reason for this cache configuration.
			interpretHeader: false,
			// Never cache a failure: the default predicate admits 3xx too.
			cachePredicate: { statusCheck: (status) => status >= HTTP_OK && status < HTTP_MULTIPLE_CHOICES },
		},
		axios: {
			headers: {
				// Per SEC's documented sample headers: a descriptive User-Agent plus Accept-Encoding.
				// `Host` is also in that sample, but this client spans multiple hosts.
				// The transport derives Host from the URL itself.
				// A hardcoded value would break requests to the other hosts.
				"User-Agent": userAgent,
				"Accept-Encoding": "gzip, deflate",
			},
			timeout: options.requestTimeoutMs ?? API_CLIENT_DEFAULTS.requestTimeoutMs,
			responseType: "json",
			// `silentJSONParsing` defaults to true.
			// Axios then hands back the RAW string when a body fails to parse instead of raising.
			// SEC occasionally serves an html error page under a 200 status.
			// Silently returning that string as `T` is exactly the poisoning this client's
			// cache rules exist to prevent, so parse failures must be errors.
			transitional: { silentJSONParsing: false },
			...options.axios,
		},
	})
}
