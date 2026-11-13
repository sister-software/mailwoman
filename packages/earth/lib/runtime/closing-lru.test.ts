// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import { ClosingLRU, closeWhenOpen } from "#runtime/closing-lru"

class Handle {
	closed = false
	readonly name: string

	constructor(name: string) {
		this.name = name
	}

	close(): void {
		this.closed = true
	}
}

function opener(opened: Handle[]) {
	return (name: string) => async () => {
		const handle = new Handle(name)

		opened.push(handle)

		return handle
	}
}

describe("ClosingLRU", () => {
	test("shares one open between reads of a key", async () => {
		const opened: Handle[] = []
		const open = opener(opened)
		const cache = new ClosingLRU<Handle>(2)

		const [a, b] = await Promise.all([cache.get("ca", open("ca")), cache.get("ca", open("ca"))])

		expect(a).toBe(b)
		expect(opened).toHaveLength(1)
	})

	test("closes the least recently used handle when a third key opens", async () => {
		const opened: Handle[] = []
		const open = opener(opened)
		const cache = new ClosingLRU<Handle>(2)

		const ca = await cache.get("ca", open("ca"))
		const ny = await cache.get("ny", open("ny"))

		// A second read of `ca` makes `ny` the least recently used.
		await cache.get("ca", open("ca"))
		await cache.get("fr", open("fr"))
		await Promise.resolve()

		expect(cache.keys()).toEqual(["ca", "fr"])
		expect(ny.closed).toBe(true)
		expect(ca.closed).toBe(false)
		expect(opened.map((handle) => handle.name)).toEqual(["ca", "ny", "fr"])
	})

	test("reopens an evicted key", async () => {
		const opened: Handle[] = []
		const open = opener(opened)
		const cache = new ClosingLRU<Handle>(1)

		const first = await cache.get("ca", open("ca"))

		await cache.get("ny", open("ny"))
		const second = await cache.get("ca", open("ca"))

		expect(first.closed).toBe(true)
		expect(second).not.toBe(first)
		expect(second.closed).toBe(false)
	})

	test("closes a handle evicted while its open was still pending, once it opens", async () => {
		const cache = new ClosingLRU<Handle>(1)
		const slow = new Handle("ca")
		let finish!: (handle: Handle) => void

		const pending = cache.get(
			"ca",
			() =>
				new Promise<Handle>((resolve) => {
					finish = resolve
				})
		)

		await cache.get("ny", async () => new Handle("ny"))

		expect(slow.closed).toBe(false)

		finish(slow)
		await pending
		await Promise.resolve()

		expect(slow.closed).toBe(true)
	})

	test("forgets a failed open so the next read retries", async () => {
		const cache = new ClosingLRU<Handle>(2)

		await expect(cache.get("ca", () => Promise.reject(new Error("offline")))).rejects.toThrow("offline")
		expect(cache.size).toBe(0)

		const handle = await cache.get("ca", async () => new Handle("ca"))

		expect(handle.closed).toBe(false)
	})

	test("clear closes every handle", async () => {
		const opened: Handle[] = []
		const open = opener(opened)
		const cache = new ClosingLRU<Handle>(2)

		await cache.get("ca", open("ca"))
		await cache.get("ny", open("ny"))
		cache.clear()
		await Promise.resolve()

		expect(cache.size).toBe(0)
		expect(opened.every((handle) => handle.closed)).toBe(true)
	})

	test("refuses a capacity below one", () => {
		expect(() => new ClosingLRU<Handle>(0)).toThrow(RangeError)
	})
})

describe("closeWhenOpen", () => {
	test("ignores a missing or failed open", async () => {
		expect(() => closeWhenOpen(null)).not.toThrow()

		const failed = Promise.reject(new Error("offline"))

		closeWhenOpen(failed)

		await expect(failed).rejects.toThrow("offline")
	})
})
