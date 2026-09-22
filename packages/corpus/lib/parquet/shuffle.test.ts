/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"
import { DEFAULT_SHUFFLE_WINDOW, shuffleWithinWindow } from "@mailwoman/corpus/parquet/shuffle"
import { describe, expect, it } from "vitest"

async function* from<T>(items: readonly T[]): AsyncIterable<T> {
	for (const item of items) {
		yield item
	}
}

async function collect<T>(rows: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = []

	for await (const row of rows) {
		out.push(row)
	}

	return out
}

describe("shuffleWithinWindow", () => {
	it("emits every input row exactly once", async () => {
		const input = Array.from({ length: 5000 }, (_, index) => index)
		const out = await collect(shuffleWithinWindow(from(input), makeMulberry32(7), 500))

		expect(out).toHaveLength(input.length)
		expect(out.toSorted((a, b) => a - b)).toEqual(input)
	})

	it("yields the input unchanged when the window is 1 or 0", async () => {
		const input = Array.from({ length: 200 }, (_, index) => index)

		expect(await collect(shuffleWithinWindow(from(input), makeMulberry32(7), 1))).toEqual(input)
		expect(await collect(shuffleWithinWindow(from(input), makeMulberry32(7), 0))).toEqual(input)
	})

	it("is reproducible for one seed and differs between two", async () => {
		const input = Array.from({ length: 2000 }, (_, index) => index)
		const a = await collect(shuffleWithinWindow(from(input), makeMulberry32(11), 400))
		const b = await collect(shuffleWithinWindow(from(input), makeMulberry32(11), 400))
		const c = await collect(shuffleWithinWindow(from(input), makeMulberry32(12), 400))

		expect(a).toEqual(b)
		expect(a).not.toEqual(c)
	})

	it("mixes countries that arrive in contiguous runs, which is the reason it exists", async () => {
		// The arrival shape `corpus-draw-coverage.mdx` measured: a source's rows are ordered by
		// country, so the first row-group holds one country and a bounded draw sees only that one.
		const countries = ["JP", "CN", "FR", "US", "ES"]
		const input = countries.flatMap((cc) => Array.from({ length: 50_000 }, () => cc))

		const before = new Set(input.slice(0, 50_000))
		expect(before.size).toBe(1)

		const out = await collect(shuffleWithinWindow(from(input), makeMulberry32(3), DEFAULT_SHUFFLE_WINDOW))
		const after = new Set(out.slice(0, 50_000))

		expect(out).toHaveLength(input.length)
		expect(after.size).toBe(countries.length)
	})

	it("holds no more than the window in memory, so a stream longer than the window still drains", async () => {
		const input = Array.from({ length: 10_000 }, (_, index) => index)
		const out = await collect(shuffleWithinWindow(from(input), makeMulberry32(5), 100))

		expect(out).toHaveLength(10_000)
		// The last 100 rows are the buffer drained at the end, so every row is still
		// accounted for rather than the tail being dropped with the buffer.
		expect(new Set(out).size).toBe(10_000)
	})
})
