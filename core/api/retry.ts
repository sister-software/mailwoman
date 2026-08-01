/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Bounded retry policy for {@linkcode APIClient} — which failures are worth another attempt, how
 *   long to wait, and the hard ceiling on both.
 *
 *   Lifted from `98c4dda1:filer/sdk/sec-client.ts`, where the `Retry-After` handling (the HTTP-date
 *   form, the long fallback for a present-but-unparseable value, and the RFC 9110 `1*DIGIT`
 *   tightening) was settled over two review rounds. The classifier is the same taxonomy that client
 *   used, restated against Axios's error shape rather than a raw `Response`.
 */

import { AxiosError, isAxiosError } from "axios"

/**
 * Rate limited — retryable, the server is asking us to back off.
 */
const HTTP_TOO_MANY_REQUESTS = 429

/**
 * The request took too long at the origin — retryable.
 */
const HTTP_REQUEST_TIMEOUT = 408

/**
 * Lowest 5xx status. Server-side failures are retryable.
 */
const HTTP_SERVER_ERROR_MIN = 500

/**
 * Highest 5xx status.
 */
const HTTP_SERVER_ERROR_MAX = 599

/**
 * A hard ceiling on how long a single retry wait is ever allowed to be, REGARDLESS of what a server-supplied
 * `Retry-After` asks for. Honoring `Retry-After` is the right side of most fair-access policies, but an unbounded
 * honor-anything policy would let a pathological (or misconfigured) server hang a bulk crawl for hours; 60s is generous
 * for anything a real rate limiter would plausibly ask for. Also the fallback used when `Retry-After` is PRESENT but
 * unparseable — a malformed header is still the server asking us to back off, and guessing LONG is the safe failure
 * mode; guessing short (the exponential default) risks hammering a server that explicitly asked for space.
 */
export const MAX_RETRY_AFTER_MS = 60_000

/**
 * Attempts a retrying client makes by default (INCLUDING the first) — a stated ceiling, not "until it works."
 */
export const DEFAULT_MAX_ATTEMPTS = 3

/**
 * Default base delay for the exponential backoff between attempts, in milliseconds.
 */
export const DEFAULT_BASE_RETRY_DELAY_MS = 500

/**
 * RFC 9110 §10.2.3: `Retry-After` is either `delay-seconds` (`1*DIGIT` — one or more ASCII digits, no sign, no decimal
 * point, no hex) or an HTTP-date. `Number("0x10")` and `Number("1.5")` both parse as valid JS numbers but are NOT valid
 * `delay-seconds`, so the numeric branch matches the RFC grammar directly instead of delegating to `Number()`.
 */
const RETRY_AFTER_DELAY_SECONDS_PATTERN = /^\d+$/

/**
 * A necessary (not sufficient) pre-check before trusting `Date.parse` on the HTTP-date branch: `Date.parse` is FAR more
 * lenient than RFC 9110's HTTP-date grammar and will happily parse plausible-looking garbage — `Date.parse("1.5")`
 * returns a valid timestamp (~Jan 2001, some locale-ish `M.D` reading), which very nearly slipped a bare
 * fractional-seconds typo through as an accepted HTTP-date instead of falling back to the long ceiling. Every valid RFC
 * 9110 HTTP-date form (the preferred IMF-fixdate AND the obsolete RFC 850 form) ends in the literal `GMT`; requiring
 * that suffix rejects `Date.parse`'s stray non-date parses without needing a full HTTP-date grammar implementation.
 */
const HTTP_DATE_SUFFIX_PATTERN = /GMT$/

/**
 * How a client should treat one failed attempt.
 */
export interface RetryDirective {
	/**
	 * Whether THIS CLASS of failure is worth another attempt — `true` for 408/429/5xx and every network-class failure
	 * (connect, DNS, timeout, mid-body-transfer drop), `false` for 403/404/other non-transient statuses, a
	 * caller-initiated cancel, and a body that failed to decode.
	 */
	retryable: boolean
	/**
	 * The server-requested wait derived from a `Retry-After` response header, in milliseconds, or `null` when the header
	 * was absent (the caller should fall back to its own exponential backoff).
	 */
	retryAfterMs: number | null
}

/**
 * Parse a `Retry-After` header value — numeric `delay-seconds` or an HTTP-date, per RFC 9110 — into a clamped wait
 * duration in ms.
 *
 * Returns `null` only when the header is ABSENT. When the header IS present, this always returns a number: the parsed
 * (and {@linkcode MAX_RETRY_AFTER_MS}-clamped) value on success, or `MAX_RETRY_AFTER_MS` itself when the value is
 * present but matches neither valid form — see the constant's docstring for why unparseable fails open toward caution
 * rather than speed.
 *
 * The HTTP-date branch compares against REAL wall-clock time (`Date.now()`), not an injectable clock — an HTTP-date is
 * an absolute calendar timestamp, which only means something relative to the actual current time.
 */
export function parseRetryAfterMs(header: string | null | undefined): number | null {
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
 * Whether an HTTP status is worth another attempt: 408 and 429 by name, plus the whole 5xx range. Everything else —
 * every other 4xx, every 2xx/3xx that still produced an error — is terminal.
 *
 * The 4xx exclusion is the load-bearing part, and 403 is why. A 403 from a rate-limited public API means the request
 * failed to identify itself (for SEC EDGAR, a missing or non-descriptive `User-Agent`); it does NOT mean the resource
 * is gone or that this client is banned. Retrying it cannot succeed and burns rate budget on a request that was never
 * going to be served. An earlier revision spelled this out as a redundant `if (status === 403) return false` ahead of
 * the range check — no mutation could kill it, because the range check already excluded 403, so it was removed rather
 * than left as unfalsifiable decoration. The property is proved by mutating this range instead: broadening it to `>=
 * 400` makes the 403 and 404 tests fail.
 */
export function isRetryableStatus(status: number): boolean {
	if (status === HTTP_TOO_MANY_REQUESTS || status === HTTP_REQUEST_TIMEOUT) return true

	return status >= HTTP_SERVER_ERROR_MIN && status <= HTTP_SERVER_ERROR_MAX
}

/**
 * Read the `Retry-After` header off an Axios error's response, if it carried one. Axios lower-cases response header
 * names, but `AxiosHeaders` lookups are case-insensitive anyway; the lower-case spelling is used for the plain-object
 * shape a stubbed adapter may return.
 */
function retryAfterFrom(error: AxiosError): number | null {
	const headers = error.response?.headers

	if (!headers) return null

	const raw = (headers as Record<string, unknown>)["retry-after"] ?? (headers as Record<string, unknown>)["Retry-After"]

	return typeof raw === "string" || typeof raw === "number" ? parseRetryAfterMs(String(raw)) : null
}

/**
 * Classify one failed attempt: is this failure class worth retrying, and did the server name its own backoff?
 *
 * A NETWORK-class failure — a dropped socket, a DNS blip, this attempt's own timeout firing, or a body read that died
 * mid-transfer — is retryable. This is the case a bulk crawler hits most: fetching multi-MB documents, a dropped socket
 * is far more common than a 503, and the standalone SEC client shipped a version that treated it as terminal.
 *
 * A caller-initiated cancel (`ERR_CANCELED`, i.e. the caller's own `AbortSignal` fired) is NOT retryable — the caller
 * asked us to stop, and retrying would defy that. Axios reports its own `timeout` config as `ECONNABORTED`/`ETIMEDOUT`,
 * so the two are distinguishable.
 */
export function classifyAxiosFailure(error: unknown): RetryDirective {
	if (!isAxiosError(error)) return { retryable: false, retryAfterMs: null }

	const retryAfterMs = retryAfterFrom(error)

	if (error.response) {
		return { retryable: isRetryableStatus(error.response.status), retryAfterMs }
	}

	// No response at all: a network-class failure, unless the caller cancelled it themselves.
	return { retryable: error.code !== AxiosError.ERR_CANCELED, retryAfterMs }
}

/**
 * Retry configuration for {@linkcode APIClient}. Pass `true` to accept every default.
 *
 * Retry is OPT-IN: an `APIClient` constructed without this option makes exactly one attempt, which is what the existing
 * `TileAPI` consumer has always done. Turning it on repo-wide would silently multiply every caller's failure latency.
 */
export interface RetryOptions {
	/**
	 * Total attempts, INCLUDING the first, before giving up. A stated ceiling, not "until it works". Default
	 * {@linkcode DEFAULT_MAX_ATTEMPTS}.
	 */
	maxAttempts?: number
	/**
	 * Base delay for the exponential backoff, in milliseconds. Attempt `n`'s wait is `baseDelayMs * 2^(n-1)`, UNLESS the
	 * response carried a `Retry-After` header, which is honored instead. Default
	 * {@linkcode DEFAULT_BASE_RETRY_DELAY_MS}.
	 */
	baseDelayMs?: number
}

/**
 * A fully-resolved retry policy — {@linkcode RetryOptions} with every default filled in.
 */
export interface ResolvedRetryPolicy {
	maxAttempts: number
	baseDelayMs: number
}

/**
 * Fill in {@linkcode RetryOptions}' defaults. `undefined` (the absent option) resolves to a single attempt — no retry.
 */
export function resolveRetryPolicy(options: RetryOptions | boolean | undefined): ResolvedRetryPolicy {
	if (!options) return { maxAttempts: 1, baseDelayMs: DEFAULT_BASE_RETRY_DELAY_MS }

	const provided = options === true ? {} : options

	return {
		maxAttempts: Math.max(1, provided.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
		baseDelayMs: provided.baseDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS,
	}
}

/**
 * The wait before attempt `attempt + 1`, given the directive from attempt `attempt` (1-based). A server-supplied
 * `Retry-After` always wins over the exponential default.
 */
export function retryDelayMs(attempt: number, directive: RetryDirective, policy: ResolvedRetryPolicy): number {
	return directive.retryAfterMs ?? policy.baseDelayMs * 2 ** (attempt - 1)
}
