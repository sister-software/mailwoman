// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * What the vital-places phases share: the progress line sink, the elapsed-time format and request batching.
 */

/**
 * A line sink for progress.
 *
 * The command passes `reportToStderr`; a test passes a collector.
 */
export type ProgressReporter = (line: string) => void

/**
 * The seconds elapsed since a `performance.now()` mark, to one decimal.
 */
export function formatElapsed(startedAt: number, now = performance.now()): string {
	return `${((now - startedAt) / 1000).toFixed(1)} s`
}

const ENTITY_PREFIX = "http://www.wikidata.org/entity/"

/**
 * The item id a Wikidata entity URI names, or the value itself when it is already an id.
 */
export function entityQID(uri: string): string {
	return uri.startsWith(ENTITY_PREFIX) ? uri.slice(ENTITY_PREFIX.length) : uri
}

/**
 * The items in consecutive batches of at most `size`, the last one shorter.
 */
export function chunked<T>(items: readonly T[], size: number): T[][] {
	if (!Number.isInteger(size) || size < 1) throw new RangeError(`a batch size is a positive integer, not ${size}`)

	const batches: T[][] = []

	for (let index = 0; index < items.length; index += size) {
		batches.push(items.slice(index, index + size))
	}

	return batches
}
