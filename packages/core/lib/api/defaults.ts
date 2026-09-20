// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The retry and timeout defaults every designated `APIClient` consumer was declaring for itself.
 */

/**
 * The shared defaults: three attempts spaced by a 500 ms exponential backoff, under a 30 s per-attempt
 * socket-inactivity timeout — the numbers the SEC, cores and BDC clients each declared before they were shared.
 */
export const API_CLIENT_DEFAULTS = {
	/**
	 * Total attempts (including the first) before giving up on a 429/5xx or a network-class failure. A stated ceiling
	 * rather than "until it works".
	 */
	maxAttempts: 3,
	/**
	 * Base delay for the exponential backoff between retry attempts, in milliseconds. Attempt `n`'s wait is
	 * `baseRetryDelayMs * 2^(n-1)`, unless the response carried a `Retry-After` header, which is honored instead.
	 */
	baseRetryDelayMs: 500,
	/**
	 * Per-attempt socket-inactivity timeout for an ordinary request, in milliseconds. A bulk download wants its own,
	 * longer ceiling.
	 */
	requestTimeoutMs: 30_000,
} as const
