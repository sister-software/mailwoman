/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { setTimeout } from "node:timers/promises"

/**
 * Resolve after `milliseconds`, or reject with the signal's reason when `signal`
 * aborts first — a backoff step, a politeness pause between requests.
 */
export function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
	return setTimeout(milliseconds, undefined, { signal })
}

/**
 * Given a callback, attempt to run it up to `attempts` times.
 *
 * @param attempts Maximum number of tries before the last error is rethrown.
 * @param callback The operation to attempt.
 *
 * @returns The callback's result from the first successful attempt.
 */
export async function tryWithBackoff<T>(attempts: number, callback: () => T): Promise<T> {
	let lastError: unknown

	for (let i = 0; i < attempts; i++) {
		try {
			const result = await callback()

			return result
		} catch (error) {
			lastError = error
		}

		// Retry after fixed-duration jitter.
		const delay = Math.floor(Math.random() * 1000) + 1000 * attempts
		await sleep(delay)
	}

	throw lastError
}
