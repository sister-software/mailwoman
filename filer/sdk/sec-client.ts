/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file SEC EDGAR HTTP client, built on {@linkcode APIClient} (3b decision 5, migrated task 5).
 *
 *   SEC's fair-access policy (https://www.sec.gov/os/accessing-edgar-data, verified against source
 *   2026-07-31) declares a max request rate of 10/second and asks for a descriptive `User-Agent`
 *   naming a company + contact address, plus `Accept-Encoding: gzip, deflate`.
 *
 *   This client used to carry its own pacer, retry loop, on-disk cache, and error type. All four now
 *   live in `@mailwoman/core/api`, because every one of them was general HTTP-client machinery that a
 *   second client would have had to re-derive (`bdc/sdk/client.ts` is still on raw `fetch` and is the
 *   obvious next migration). What remains here is the part that is genuinely SEC-specific:
 *
 *     1. UA fail-fast off `$private.SEC_EDGAR_USER_AGENT` — a silently-UA-less client just 403s on
 *        first use, which is a worse failure mode than failing at construction.
 *     2. The 10 req/s ceiling, expressed as {@linkcode APIClientConfig.minRequestIntervalMs} and
 *        clamped regardless of a caller-supplied rate, so a misconfigured caller cannot push past the
 *        policy limit. NOT a token bucket: capacity C admits `C + rate * 1s` inside a sliding second,
 *        so no non-zero capacity honors a FLAT cap — see `core/api/pacer.ts`.
 *     3. The immutable-archive-vs-TTL cache rule — see {@linkcode isImmutableArchiveURL}.
 *     4. A host allowlist, https-only. This is the designated SEC client; it refuses to send the
 *        configured UA (a real contact address) to an arbitrary caller-supplied host, or in cleartext.
 *     5. The 403 explanation. A bare 403 from sec.gov means "you didn't identify yourself":
 *        reproduced by hitting the same URL with and without a compliant UA — no UA is a 403, a
 *        descriptive one is a 200. It does NOT mean the resource is missing or that this client/IP is
 *        blocked, and retrying it would only burn the 10 req/s budget, so 403 is non-retryable
 *        (`core/api/retry.ts`) and the thrown error says all of this explicitly. This project already
 *        lost a debugging cycle to a generic "403 Forbidden" on an FCC endpoint.
 *
 *   ERROR CONTRACT. Every failure past construction is a {@linkcode ResourceError} — no bespoke error
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
 *   REDIRECT POLICY — documented, not implemented: Axios follows redirects automatically, and the host
 *   allowlist is checked against the ORIGINAL request URL, not each hop. A redirect from an allowed
 *   host to an arbitrary one would carry the configured UA there unchecked. Accepted for now — EDGAR's
 *   public JSON/document endpoints don't redirect cross-host in normal operation — but a future
 *   hardening pass fetching caller-discovered (as opposed to hardcoded) URLs should set
 *   `maxRedirects: 0` and re-validate the `Location` host per hop before following it.
 */

import { APIClient, type APIClientConfig, type ClockLike } from "@mailwoman/core/api"
import { buildDiskStorage } from "@mailwoman/core/api/disk-storage"
import { $private } from "@mailwoman/core/env"
import { ResourceError } from "@mailwoman/core/errors"
import { dataRootPath } from "@mailwoman/core/utils"

// Re-exported so a caller branching on this client's failures needs exactly one import.
export { isTransientResourceError } from "@mailwoman/core/api"
export { ResourceError } from "@mailwoman/core/errors"

/**
 * The SEC fair-access policy's stated ceiling (https://www.sec.gov/os/accessing-edgar-data): "Current max request rate:
 * 10 requests/second." {@linkcode createSECClient} clamps to this regardless of a caller-supplied value, and because the
 * underlying pacer is strict-interval rather than a bucket, this is a hard ceiling on the SCHEDULE, not a steady-state
 * average.
 */
export const SEC_MAX_REQUESTS_PER_SECOND = 10

/**
 * What this client actually paces at — deliberately ONE BELOW {@linkcode SEC_MAX_REQUESTS_PER_SECOND}.
 *
 * Pacing exactly at the ceiling puts every grant on a schedule with zero slack, and the schedule is not what SEC
 * measures — the arriving request is. Measured end-to-end through {@linkcode createSECClient} on real timers, a 40-call
 * fan-out at 10/s produced **11 requests inside one sliding second on 3 of 3 runs**: the grants themselves are spaced
 * correctly, but the continuation that issues the request lands 0-2 ms late and tips one grant across the boundary (the
 * preceding second then holds 9). Against a true sliding-window limiter that is a violation, and it happens on a
 * schedule that is arithmetically compliant — which is exactly the kind of correctness nobody can debug after a block.
 *
 * One request per second of headroom costs ~10% throughput on a crawl that is already cache-heavy, and buys a schedule
 * that stays inside the published limit even when the event loop is late. `SEC_MAX_REQUESTS_PER_SECOND` remains the
 * clamp — a caller may ask for anything up to it — but the DEFAULT is this. Raise it only with a measurement showing
 * the arrival-time distribution stays under 10/s, not merely the grant times.
 *
 * THE RATE ALONE IS NOT ENOUGH, and this constant did not meet its own bar when it was introduced. `1000 / 9` is
 * `111.111…`, and a fractional interval puts the 10th grant at exactly 1000.0 ms after the first — so sub-millisecond
 * jitter tips a 10th arrival into the window every time, measured 5/5 runs. {@linkcode createSECClient} therefore CEILS
 * the interval (`Math.ceil(1000 / 9)` = 112 ms), which moves the 10th grant to 1008 ms and costs 0.8% throughput.
 * Measured after the ceil: 9 arrivals per sliding second, 3/3 runs. Any future rate that does not divide 1000 evenly
 * needs the same treatment, which is why the ceil lives at the single construction site rather than in the constant.
 */
export const SEC_DEFAULT_REQUESTS_PER_SECOND = 9

/**
 * Milliseconds in a second — the numerator when turning a requests/second rate into a pacing interval.
 */
const MS_PER_SECOND = 1000

/**
 * How long a cached entry for a MUTABLE endpoint stays fresh by default. 24h: generous enough to avoid re-hammering the
 * submissions index/ticker map on every run, short enough that a day-old crosswalk build still notices a company's
 * newest 10-K.
 */
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * The TTL applied to an immutable archive document — a century, not `Infinity`.
 *
 * `Infinity` is the obvious spelling of "never expires" and the wrong one: `JSON.stringify(Infinity)` is `"null"`, and
 * `null` reads back as `0` in the cache interceptor's `createdAt + ttl < Date.now()` expiry test, so a "permanent"
 * entry would round-trip through disk into one that is expired the instant it is read. `buildDiskStorage` refuses a
 * non-finite TTL outright for exactly this reason.
 */
const PERMANENT_CACHE_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000

/**
 * The status a request that failed to identify itself comes back as. See the file header — this one gets its own
 * explanation rather than a generic "Forbidden".
 */
const HTTP_FORBIDDEN = 403

/**
 * The lowest success status, and the first status past the success range — the window a response must land in before
 * its body is worth caching. Deliberately narrower than the interceptor's default, which admits 3xx too.
 */
const HTTP_OK = 200
const HTTP_MULTIPLE_CHOICES = 300

/**
 * Total attempts (including the first) before giving up on a 429/5xx or a network-class failure.
 */
const DEFAULT_MAX_ATTEMPTS = 3

/**
 * Base delay for the exponential backoff between retry attempts, in milliseconds.
 */
const DEFAULT_BASE_RETRY_DELAY_MS = 500

/**
 * Per-attempt request timeout, in milliseconds.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

const SEC_ARCHIVE_PATH_PATTERN = /^\/Archives\/edgar\/data\//

/**
 * EDGAR archive documents (10-Ks, Exhibit 21 subsidiary lists, and every other filing exhibit) live at a path of this
 * shape once submitted, e.g. `https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/aapl-20230930.htm`. SEC
 * does not revise a filed document in place — a correction is a NEW filing at a new path — so a document fetched today
 * reads identically a year from now. Caching these effectively forever is the correct, deliberate choice: it saves a
 * network round-trip (and rate-limit budget) on every re-run with zero staleness risk.
 *
 * Every other endpoint this client is asked to reach — the submissions index (`/submissions/CIK##########.json`), the
 * ticker map (`/files/company_tickers.json`), and the classic browse-edgar CGI — is a live index that changes as new
 * filings land or tickers get reassigned. Caching those forever would be the WRONG choice (a stale submissions index
 * would silently hide a company's newest 10-K from tasks 6-8), so entries for URLs this returns `false` for expire
 * after `cacheTTLMs` instead.
 */
export function isImmutableArchiveURL(url: URL): boolean {
	return SEC_ARCHIVE_PATH_PATTERN.test(url.pathname)
}

/**
 * The only hosts this client will ever send a request to. {@linkcode SECClient.get} refuses (before any
 * cache/rate-limit/network activity) a URL on any other host, or any non-https scheme — this is the designated SEC
 * EDGAR client, and its configured User-Agent carries a real contact address; sending that anywhere a caller happens to
 * point it (or in cleartext) would leak it outside SEC's fair-access program for no benefit.
 *
 * `sec.gov` (the apex) and `efts.sec.gov` (EDGAR full-text search — task 8's Exhibit 21 discovery path) are included
 * alongside the two hosts decision 5 originally verified. Matching is EXACT (a `Set` lookup on `url.hostname`), not a
 * suffix check — `www.sec.gov.attacker.example` must NOT match, and an `.endsWith(".sec.gov")`-style check would let it
 * through. `url.hostname` (from the WHATWG URL parser) already lower-cases, strips userinfo, and
 * percent/punycode-decodes, so those bypasses need no extra handling.
 */
const SEC_ALLOWED_HOSTS = new Set(["www.sec.gov", "data.sec.gov", "sec.gov", "efts.sec.gov"])

/**
 * A trailing dot makes a hostname fully qualified — `www.sec.gov.` and `www.sec.gov` reach the same server, but only
 * the latter is in the allowlist, and the WHATWG parser preserves the dot. Stripped before the lookup so the FQDN form
 * is admitted rather than rejected as an unknown host.
 */
function canonicalHostname(url: URL): string {
	return url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname
}

/**
 * Reject a URL this client must not send its User-Agent to. Throws a {@linkcode ResourceError} whose URN kind is
 * `request` — never transient, because re-issuing the identical URL can only fail identically.
 */
function assertSECHost(url: URL): void {
	if (url.protocol !== "https:") {
		throw ResourceError.from(
			400,
			`createSECClient: refusing to request "${url}" over ${url.protocol.replace(":", "")} — this client only ` +
				"sends requests over https, so the configured User-Agent (a contact address) is never sent in cleartext.",
			"sec",
			"request",
			"insecure-scheme"
		)
	}

	if (!SEC_ALLOWED_HOSTS.has(canonicalHostname(url))) {
		throw ResourceError.from(
			400,
			`createSECClient: refusing to request "${url}" — this client only sends requests to SEC EDGAR hosts ` +
				`(${[...SEC_ALLOWED_HOSTS].join(", ")}). Sending the configured User-Agent (a contact address) to an ` +
				"arbitrary caller-supplied host would leak it outside SEC's fair-access program.",
			"sec",
			"request",
			"host-not-allowed"
		)
	}
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
	 * Desired requests/second. Clamped to `[1, SEC_MAX_REQUESTS_PER_SECOND]` regardless of what's passed. Defaults to
	 * {@linkcode SEC_DEFAULT_REQUESTS_PER_SECOND}, which is one below the policy ceiling on purpose — see that constant
	 * for the measurement behind it.
	 */
	requestsPerSecond?: number
	/**
	 * Time source powering the pacer and the retry backoff. Defaults to the system clock. Tests inject a fake clock so
	 * rate-limit and retry behavior are deterministic and fast — no wall-clock sleeps in the suite.
	 */
	clock?: ClockLike
	/**
	 * On-disk cache root. Defaults to `dataRootPath("sec", "cache")`, resolved once at construction (the standalone
	 * client re-resolved it per request; construct the client after setting `$MAILWOMAN_DATA_ROOT` instead).
	 */
	cacheDir?: string
	/**
	 * How long a cached entry for a MUTABLE endpoint (anything {@linkcode isImmutableArchiveURL} returns `false` for)
	 * stays fresh, in milliseconds. Archive documents ignore this entirely.
	 */
	cacheTTLMs?: number
	/**
	 * Total attempts (including the first) before giving up on a 429/5xx or a network-class failure (connect, timeout, or
	 * mid-body-transfer). A STATED CEILING, not "until it works". Never applies to a 403.
	 */
	maxAttempts?: number
	/**
	 * Base delay for the exponential backoff between retry attempts, in milliseconds. Attempt `n`'s wait is
	 * `baseRetryDelayMs * 2^(n-1)`, UNLESS the response carried a `Retry-After` header, which is honored instead.
	 */
	baseRetryDelayMs?: number
	/**
	 * Per-attempt request timeout, in milliseconds. Covers the whole attempt including the body read — a document slower
	 * than this to transfer aborts and retries, same as a connect failure.
	 */
	requestTimeoutMs?: number
	/**
	 * Axios overrides, merged over this client's own defaults. The test seam: every test in `sec-client.test.ts` passes
	 * an `adapter` here, so no test ever performs a live network call (decision 5). Overriding `headers` wholesale would
	 * drop the User-Agent, so don't.
	 */
	axios?: APIClientConfig["axios"]
}

/**
 * {@linkcode APIClient} configuration plus the SEC-specific fields {@linkcode SECClient} reads back off `config`.
 */
export interface SECClientConfig extends APIClientConfig {
	/**
	 * The fair-access User-Agent every request carries. Named in the 403 explanation so a maintainer can see what was
	 * actually sent.
	 */
	userAgent: string
}

/**
 * Rewrite a 403 into an error that tells a maintainer what actually went wrong. A generic "403 Forbidden" reads as
 * "blocked" or "missing" and sends the reader down the wrong path; the real cause is almost always the User-Agent. The
 * URN and status are reconstructed identically, so the caller's `status === 403` branch is unaffected.
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
 * A SEC EDGAR client. Constructed via {@linkcode createSECClient}, which resolves the User-Agent and every default.
 */
export class SECClient extends APIClient<SECClientConfig> {
	/**
	 * Issue a `GET` against a full absolute EDGAR URL (https, on an allowed host only) and return the parsed JSON body,
	 * subject to the on-disk cache, the request pacer, and bounded retry.
	 *
	 * Takes a full absolute URL rather than a path appended to one base: EDGAR is served across several hosts, so there
	 * is no single base to append to.
	 *
	 * Concurrent calls for the same URL that both miss the cache share a single in-flight request — the cache
	 * interceptor's own stampede guard, which the bespoke client had to hand-roll.
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
}

/**
 * The TTL for one response: permanent for an immutable archive document, `mutableTTLMs` for everything else.
 *
 * Structurally typed rather than importing `CacheAxiosResponse` — `filer` deliberately depends on neither `axios` nor
 * `axios-cache-interceptor`, reaching both only through `@mailwoman/core`.
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
 * Create a SEC EDGAR HTTP client. See the file header for the full rationale.
 *
 * Throws immediately, before any request is made, when constructed without an explicit `userAgent` AND without
 * `SEC_EDGAR_USER_AGENT` set.
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
			maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
			baseDelayMs: options.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS,
		},
		clock: options.clock,
		caching: {
			storage: buildDiskStorage({
				directory: options.cacheDir ?? dataRootPath("sec", "cache"),
				// Validate BEFORE writing. Axios already rejects an unparseable body (see
				// `transitional.silentJSONParsing` below), so this is the second gate rather than the first:
				// every EDGAR endpoint this client reaches returns a JSON object or array, so a decoded body
				// that isn't one means the upstream served something other than what it claimed — and an
				// `/Archives/` entry cached under the permanent TTL has no self-healing path short of
				// hand-deleting a hash-named file.
				validate: (value) => typeof value.data?.data === "object" && value.data.data !== null,
			}),
			ttl: (response) => responseTTL(response, cacheTTLMs),
			// SEC sends its own `Cache-Control`. Honoring it would override the archive-vs-index rule above,
			// which is the whole point of the cache configuration here.
			interpretHeader: false,
			// Never cache a failure: the default predicate admits 3xx too.
			cachePredicate: { statusCheck: (status) => status >= HTTP_OK && status < HTTP_MULTIPLE_CHOICES },
		},
		axios: {
			headers: {
				// Per SEC's documented sample headers: a descriptive User-Agent plus Accept-Encoding. `Host`
				// is also in that sample, but this client spans multiple hosts — the transport derives Host
				// from the URL itself, and hardcoding one here would break requests to the others.
				"User-Agent": userAgent,
				"Accept-Encoding": "gzip, deflate",
			},
			timeout: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
			responseType: "json",
			// `silentJSONParsing` defaults to TRUE, which makes Axios hand back the RAW STRING when a body
			// fails to parse instead of raising. SEC occasionally serves an HTML error page under a 200
			// status; silently returning that string as `T` is exactly the poisoning this client's cache
			// rules exist to prevent, so parse failures must be errors.
			transitional: { silentJSONParsing: false },
			...options.axios,
		},
	})
}
