import { afterEach, describe, expect, it, vi } from "vitest"

import { systemClock } from "#api/clock"

afterEach(() => vi.useRealTimers())

describe("systemClock.sleep", () => {
	it("clears an aborted timer and rejects with the signal's reason", async () => {
		vi.useFakeTimers()

		const controller = new AbortController()
		const reason = new Error("shutdown")
		const pending = systemClock.sleep(60_000, controller.signal)
		const rejected = pending.catch((error: unknown) => error)

		expect(vi.getTimerCount()).toBe(1)
		controller.abort(reason)
		expect(await rejected).toBe(reason)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("does not schedule a timer for an already aborted signal", async () => {
		vi.useFakeTimers()

		const reason = new Error("shutdown")

		await expect(systemClock.sleep(60_000, AbortSignal.abort(reason))).rejects.toBe(reason)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("removes the abort listener when a timer completes", async () => {
		vi.useFakeTimers()

		const controller = new AbortController()
		const removeListener = vi.spyOn(controller.signal, "removeEventListener")
		const pending = systemClock.sleep(10, controller.signal)

		await vi.advanceTimersByTimeAsync(10)
		await pending
		expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function))
		controller.abort()
		expect(vi.getTimerCount()).toBe(0)
	})
})
