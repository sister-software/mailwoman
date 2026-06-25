/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"
import { isIndexedIterable, isIterable, iterateInParallel, pivot, sumOf, take } from "./collections.js"

test("sumOf: totals the named numeric property across an iterable", () => {
	const items = [{ n: 1 }, { n: 2 }, { n: 3 }]

	expect(sumOf(items, "n")).toBe(6)
})

test("sumOf: an empty iterable sums to zero", () => {
	expect(sumOf([], "n" as never)).toBe(0)
})

test("sumOf: works over any iterable, not just arrays", () => {
	const set = new Set([{ weight: 10 }, { weight: 20 }, { weight: 5 }])

	expect(sumOf(set, "weight")).toBe(35)
})

test("sumOf: handles negative and fractional values", () => {
	const items = [{ v: 1.5 }, { v: -0.5 }, { v: 2 }]

	expect(sumOf(items, "v")).toBe(3)
})

/**
 * `take` yields a single reused buffer (it mutates `batch.length = 0` between yields), so it must
 * be consumed one batch at a time. Snapshot each batch as it arrives — exactly how a batched async
 * loop uses it — rather than retaining references via a spread.
 */
function drainTake<T>(collection: Iterable<T>, batchSize: number): T[][] {
	const out: T[][] = []

	for (const batch of take(collection, batchSize)) {
		out.push([...batch])
	}

	return out
}

test("take: batches an iterable into arrays of the given size", () => {
	expect(drainTake([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
})

test("take: a final short batch is still yielded", () => {
	expect(drainTake([1, 2, 3], 2)).toEqual([[1, 2], [3]])
})

test("take: an evenly-divisible iterable yields no trailing partial batch", () => {
	expect(drainTake([1, 2, 3, 4], 2)).toEqual([
		[1, 2],
		[3, 4],
	])
})

test("take: an empty iterable yields nothing", () => {
	expect(drainTake([], 3)).toEqual([])
})

test("take: a batch size larger than the collection yields a single batch", () => {
	expect(drainTake([1, 2], 10)).toEqual([[1, 2]])
})

test("take: yields one batch per consumed step (lazy streaming contract)", () => {
	const iterator = take([1, 2, 3], 2)[Symbol.iterator]()

	const first = iterator.next()
	expect(first.done).toBe(false)
	expect([...first.value!]).toEqual([1, 2])

	const second = iterator.next()
	expect(second.done).toBe(false)
	expect([...second.value!]).toEqual([3])

	expect(iterator.next().done).toBe(true)
})

test("iterateInParallel: drains an async iterable to completion", async () => {
	let drained = 0

	async function* gen(): AsyncGenerator<number> {
		yield 1
		yield 2
		yield 3
	}

	async function* counting(): AsyncGenerator<number> {
		for await (const v of gen()) {
			drained++
			yield v
		}
	}

	await expect(iterateInParallel(counting())).resolves.toBeUndefined()
	expect(drained).toBe(3)
})

test("pivot: maps each value to the synchronous callback result", () => {
	const result = pivot(["a", "bb", "ccc"], (value) => value.length)

	expect(result).toEqual({ a: 1, bb: 2, ccc: 3 })
})

test("pivot: an empty iterable pivots to an empty record", () => {
	expect(pivot([], (v) => v)).toEqual({})
})

test("pivot: resolves a record of awaited values when the callback is async", async () => {
	const result = pivot(["x", "y"], async (value) => value.toUpperCase())

	await expect(result).resolves.toEqual({ x: "X", y: "Y" })
})

test("pivot: later keys overwrite earlier duplicates", () => {
	const result = pivot(["dup", "dup"], (value) => value.length)

	expect(result).toEqual({ dup: 3 })
})

test("isIterable: recognizes arrays, strings, sets, and maps", () => {
	expect(isIterable([])).toBe(true)
	expect(isIterable("abc")).toBe(true)
	expect(isIterable(new Set())).toBe(true)
	expect(isIterable(new Map())).toBe(true)
})

test("isIterable: rejects plain objects, numbers, null, and undefined", () => {
	expect(isIterable({})).toBe(false)
	expect(isIterable(42)).toBe(false)
	expect(isIterable(null)).toBe(false)
	expect(isIterable(undefined)).toBe(false)
})

test("isIndexedIterable: true for collections exposing a has() method", () => {
	expect(isIndexedIterable(new Set([1, 2]))).toBe(true)
	expect(isIndexedIterable(new Map([["a", 1]]))).toBe(true)
})

test("isIndexedIterable: false for an array (no has())", () => {
	expect(isIndexedIterable([1, 2, 3])).toBe(false)
})
