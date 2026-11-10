/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { memoizeResettable } from "#promises"

describe("memoizeResettable", () => {
	it("shares one in-flight call between concurrent callers and keeps a resolved value", async () => {
		let calls = 0

		const read = memoizeResettable(async () => {
			calls++

			return calls
		})

		await expect(Promise.all([read(), read()])).resolves.toEqual([1, 1])
		await expect(read()).resolves.toBe(1)
		expect(calls).toBe(1)
	})

	it("calls again after a rejection, so a transient failure does not stay cached", async () => {
		let calls = 0

		const read = memoizeResettable(async () => {
			calls++

			if (calls === 1) throw new Error("first load failed")

			return "loaded"
		})

		await expect(read()).rejects.toThrow("first load failed")
		await expect(read()).resolves.toBe("loaded")
		await expect(read()).resolves.toBe("loaded")
		expect(calls).toBe(2)
	})

	it("hands every caller of a failing call the same rejection", async () => {
		const read = memoizeResettable(async () => {
			throw new Error("down")
		})

		const [first, second] = await Promise.allSettled([read(), read()])

		expect(first).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: "down" }) })
		expect(second).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: "down" }) })
	})
})
