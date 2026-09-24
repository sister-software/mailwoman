/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Bounded retry policy for `APIClient`, including RFC 9110 `Retry-After` parsing and Axios error classification.
 */

import { AxiosError, isAxiosError } from "axios"

/**
 * HTTP status for rate limiting.
 */
const HTTP_TOO_MANY_REQUESTS = 429

/**
 * HTTP status for an origin timeout.
 */
const HTTP_REQUEST_TIMEOUT = 408

/**
 * First HTTP server-error status.
 */
const HTTP_SERVER_ERROR_MIN = 500

/**
 * Last HTTP server-error status.
 */
const HTTP_SERVER_ERROR_MAX = 599

/**
 * Maximum wait for `Retry-After`, also used when a present header cannot be parsed.
 */
export const MAX_RETRY_AFTER_MS = 60_000

/**
 * Default maximum attempts, including the initial request.
 */
export const DEFAULT_MAX_ATTEMPTS = 3

/**
 * Default base delay for the exponential backoff between attempts, in milliseconds.
 */
export const DEFAULT_BASE_RETRY_DELAY_MS = 500

/**
 * RFC 9110 delay-seconds syntax: one or more ASCII digits.
 */
const RETRY_AFTER_DELAY_SECONDS_PATTERN = /^\d+$/

/**
 * Require the `GMT` suffix before passing a value to lenient `Date.parse`.
 */
const HTTP_DATE_SUFFIX_PATTERN = /GMT$/

/**
 * How a client should treat one failed attempt.
 */
export interface RetryDirective {
	/**
	 * Whether this class of failure is worth another attempt.
	 *
	 * `true` for 408/429/5xx and every network-class failure
	 * (connect, DNS, timeout, mid-body-transfer drop), `false` for 403/404/other non-transient
	 * statuses, a caller-initiated cancel, and a body that failed to decode.
	 */
	retryable: boolean
	/**
	 * The server-requested wait derived from a `Retry-After` response header, in milliseconds, or `null`
	 * when the header was absent (the caller should fall back to its own exponential backoff).
	 */
	retryAfterMs: number | null
}

/**
 * Parse a `Retry-After` header value — numeric `delay-seconds` or an http-date,
 * per RFC 9110 — into a clamped wait duration in ms.
 *
 * Returns `null` only when the header is absent.
 * When the header is present, this always returns a number: the parsed
 * (and {@linkcode MAX_RETRY_AFTER_MS}-clamped) value on success, or `MAX_RETRY_AFTER_MS`
 * itself when the value is present but matches neither valid form.
 *
 * See the constant's docstring for why unparseable fails open toward caution rather than speed.
 *
 * The http-date branch compares against real wall-clock time (`Date.now()`), not an injectable clock.
 * An http-date is an absolute calendar timestamp, which only means something
 * relative to the actual current time.
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
 * Return whether the status is 408, 429, or in the 5xx range.
 * Other statuses are terminal.
 */
export function isRetryableStatus(status: number): boolean {
	if (status === HTTP_TOO_MANY_REQUESTS || status === HTTP_REQUEST_TIMEOUT) return true

	return status >= HTTP_SERVER_ERROR_MIN && status <= HTTP_SERVER_ERROR_MAX
}

/**
 * Read the `Retry-After` header off an Axios error's response, if it carried one.
 *
 * Axios lower-cases response header names, but `AxiosHeaders` lookups are case-insensitive anyway.
 * The lower-case spelling is used for the plain-object shape a stubbed adapter may return.
 */
function retryAfterFrom(error: AxiosError): number | null {
	const headers = error.response?.headers

	if (!headers) return null

	const raw = (headers as Record<string, unknown>)["retry-after"] ?? (headers as Record<string, unknown>)["Retry-After"]

	return typeof raw === "string" || typeof raw === "number" ? parseRetryAfterMs(String(raw)) : null
}

/**
 * Classify one failed attempt: is this failure class worth retrying,
 * and did the server name its own backoff?
 *
 * A network-class failure — a dropped socket, a DNS blip, this attempt's own timeout firing,
 * or a body read that died mid-transfer — is retryable.
 * This is the case a bulk crawler hits most: fetching multi-MB documents, a dropped socket is far more
 * common than a 503, and the standalone SEC client shipped a version that treated it as terminal.
 *
 * A caller-initiated cancel (`ERR_CANCELED`, i.e. the caller's own `AbortSignal` fired) is not retryable.
 * The caller asked us to stop, and retrying would defy that.
 *
 * Axios reports its own `timeout` config as `econnaborted`/`etimedout`, so the two are distinguishable.
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
 * Retry configuration for {@linkcode APIClient}.
 *
 * Pass `true` to accept every default.
 *
 * Retry is OPT-IN: an `APIClient` constructed without this option makes exactly one attempt,
 * which is what the existing `TileAPI` consumer has always done.
 * Turning it on repo-wide would silently multiply every caller's failure latency.
 */
export interface RetryOptions {
	/**
	 * Total attempts, including the first, before giving up.
	 *
	 * A stated ceiling rather than "until it works".
	 * Default {@linkcode DEFAULT_MAX_ATTEMPTS}.
	 */
	maxAttempts?: number
	/**
	 * Base delay for the exponential backoff, in milliseconds.
	 *
	 * Attempt `n`'s wait is `baseDelayMs * 2^(n-1)`, unless the response carried a
	 * `Retry-After` header, which is honored instead.
	 * Default {@linkcode DEFAULT_BASE_RETRY_DELAY_MS}.
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
 * Fill in {@linkcode RetryOptions}' defaults.
 *
 * `undefined` (the absent option) resolves to a single attempt — no retry.
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
 * The wait before attempt `attempt + 1`, given the directive from attempt `attempt` (1-based).
 *
 * A server-supplied `Retry-After` always wins over the exponential default.
 */
export function retryDelayMs(attempt: number, directive: RetryDirective, policy: ResolvedRetryPolicy): number {
	return directive.retryAfterMs ?? policy.baseDelayMs * 2 ** (attempt - 1)
}
