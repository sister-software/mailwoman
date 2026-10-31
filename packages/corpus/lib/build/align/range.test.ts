/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { planAlignRanges } from "#build/align/range"
import { alignRangeCount } from "#build/parallel"

let scratch: TemporaryDirectory

beforeEach(async () => {
	scratch = await temporaryDirectory("mailwoman-align-range-")
})

afterEach(async () => {
	await scratch[Symbol.asyncDispose]()
})

describe("planAlignRanges", () => {
	it("divides a file into contiguous ranges that each start a line and together cover every byte", async () => {
		const lines = Array.from({ length: 101 }, (_, i) => `{"row":${i},"pad":"${"x".repeat(i % 17)}"}`)
		const path = scratch.path("canonical.jsonl")

		await writeLocalTextFile(`${lines.join("\n")}\n`, path)

		const bytes = await readLocalBuffer(path)

		for (const count of [1, 2, 3, 7, 20]) {
			const plans = await planAlignRanges(path, count)

			expect(plans).toHaveLength(count)
			expect(plans[0]!.start).toBe(0)
			expect(plans.at(-1)!.end).toBe(bytes.length)

			for (const [index, plan] of plans.entries()) {
				expect(plan.end).toBeGreaterThan(plan.start)

				if (index > 0) {
					expect(plan.start).toBe(plans[index - 1]!.end)
					expect(bytes[plan.start - 1]).toBe(0x0a)
				}
			}

			// Planned twice, the same file divides at the same offsets.
			await expect(planAlignRanges(path, count)).resolves.toEqual(plans)
		}
	})

	it("yields fewer ranges than asked for a file with fewer lines, and one empty range for an empty file", async () => {
		const short = scratch.path("short.jsonl")
		const empty = scratch.path("empty.jsonl")

		await writeLocalTextFile('{"a":1}\n{"b":2}\n', short)
		await writeLocalTextFile("", empty)

		expect((await planAlignRanges(short, 5)).map((plan) => [plan.start, plan.end])).toEqual([
			[0, 8],
			[8, 16],
		])

		await expect(planAlignRanges(empty, 3)).resolves.toEqual([
			{ index: 0, count: 1, canonicalBytes: 0, start: 0, end: 0 },
		])
	})
})

describe("alignRangeCount", () => {
	it("asks for one range per range size, at least one and at most twice the job count", () => {
		expect(alignRangeCount(0, 100, 3)).toBe(1)
		expect(alignRangeCount(100, 100, 3)).toBe(1)
		expect(alignRangeCount(101, 100, 3)).toBe(2)
		expect(alignRangeCount(10_000, 100, 3)).toBe(6)
	})
})
