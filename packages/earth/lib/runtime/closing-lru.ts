// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A small least-recently-used cache of opened handles that closes each handle it drops.
 *
 *   Earth opens a range-read database per street extract.
 *   Each one holds a worker with its own sqlite-wasm heap and chunk cache.
 *
 *   A cache that kept every extract a session touched would add one worker per region visited.
 */

/**
 * A handle whose teardown frees what it holds.
 */
export interface Closable {
	close(): void
}

/**
 * Closes the handle a pending open resolves to, and ignores an open that failed.
 */
export function closeWhenOpen(opening: Promise<Closable> | null | undefined): void {
	opening?.then(
		(handle) => handle.close(),
		() => {}
	)
}

/**
 * Keeps at most `capacity` opened handles by key.
 *
 * A new key past the limit closes the least recently used handle.
 *
 * The cache holds the pending open, so two reads of one key share one open.
 * A failed open leaves the cache, so the next read of its key tries again.
 *
 * A handle closed by eviction rejects later reads.
 * A caller still holding it from an earlier read gets that rejection, and its next read reopens the key.
 */
export class ClosingLRU<V extends Closable> {
	readonly capacity: number
	#entries = new Map<string, Promise<V>>()

	constructor(capacity: number) {
		if (!Number.isInteger(capacity) || capacity < 1) {
			throw new RangeError(`ClosingLRU capacity must be a positive integer, got ${capacity}`)
		}

		this.capacity = capacity
	}

	/**
	 * The count of keys held, including opens still pending.
	 */
	get size(): number {
		return this.#entries.size
	}

	/**
	 * The keys held, least recently used first.
	 */
	keys(): string[] {
		return [...this.#entries.keys()]
	}

	/**
	 * Returns the handle for `key`, opening it with `open` when the cache doesn't hold it.
	 */
	get(key: string, open: () => Promise<V>): Promise<V> {
		const held = this.#entries.get(key)

		if (held) {
			// A delete and set moves the key to the most recently used end of the map's insertion order.
			this.#entries.delete(key)
			this.#entries.set(key, held)

			return held
		}

		const opening = open()

		this.#entries.set(key, opening)

		opening.catch(() => {
			if (this.#entries.get(key) === opening) {
				this.#entries.delete(key)
			}
		})

		for (const oldest of this.#entries.keys()) {
			if (this.#entries.size <= this.capacity) break

			closeWhenOpen(this.#entries.get(oldest))
			this.#entries.delete(oldest)
		}

		return opening
	}

	/**
	 * Closes every handle and empties the cache.
	 */
	clear(): void {
		for (const opening of this.#entries.values()) {
			closeWhenOpen(opening)
		}

		this.#entries.clear()
	}
}
