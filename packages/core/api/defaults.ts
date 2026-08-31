/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The retry and timeout defaults every designated `APIClient` consumer was declaring for itself.
 */

/**
 * The shared defaults: three attempts spaced by a 500 ms exponential backoff, under a 30 s per-attempt
 * socket-inactivity timeout — the numbers the SEC, CORES and BDC clients each declared before they were shared.
 */
export const API_CLIENT_DEFAULTS = {
	/**
	 * Total attempts (including the first) before giving up on a 429/5xx or a network-class failure. A STATED CEILING,
	 * not "until it works".
	 */
	maxAttempts: 3,
	/**
	 * Base delay for the exponential backoff between retry attempts, in milliseconds. Attempt `n`'s wait is
	 * `baseRetryDelayMs * 2^(n-1)`, UNLESS the response carried a `Retry-After` header, which is honored instead.
	 */
	baseRetryDelayMs: 500,
	/**
	 * Per-attempt socket-inactivity timeout for an ordinary request, in milliseconds. A bulk download wants its own,
	 * longer ceiling.
	 */
	requestTimeoutMs: 30_000,
} as const
