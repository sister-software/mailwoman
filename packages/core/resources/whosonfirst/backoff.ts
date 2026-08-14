/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Retry-with-backoff helper for the Who's On First data sources.
 *
 *   This lives apart from `DataSourceCache` because both that module and `PlacetypeDataSource` need
 *   it, and each already imports the other — putting it in either one closes an import cycle.
 */

import { setTimeout } from "node:timers/promises"

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

		// We try to avoid contention by giving a pause between attempts.
		const delay = Math.floor(Math.random() * 1000) + 1000 * attempts
		await setTimeout(delay)
	}

	throw lastError
}
