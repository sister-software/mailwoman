import { sleep } from "#utils/sleep"

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Retry-with-backoff helper for the Who's On First data sources.
 *
 *   It stays separate from `DataSourceCache` and `PlacetypeDataSource` to avoid an import cycle.
 */

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
