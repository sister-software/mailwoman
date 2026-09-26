/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   {@linkcode VirtualClock.runUntilSettled}'s stuck-work guard budgets real elapsed time with `performance.now()`, not the fakeable `Date`.
 */

import { realDelay, VirtualClock } from "@mailwoman/core/api/test-clocks"
import { describe, expect, it, vi } from "vitest"

describe("VirtualClock.runUntilSettled — the stuck-work guard", () => {
	it("waits out real I/O that outlasts any turn budget", async () => {
		const clock = new VirtualClock()

		// 50ms of real time is thousands of idle `setImmediate` turns, so the work is
		// never stuck and only the turn-denominated budget was wrong.
		await expect(clock.runUntilSettled(realDelay(50))).resolves.toBeUndefined()
	})

	it("still drives virtual sleeps to completion", async () => {
		const clock = new VirtualClock()

		const work = (async () => {
			await clock.sleep(60_000)
			await clock.sleep(60_000)

			return clock.now()
		})()

		await expect(clock.runUntilSettled(work)).resolves.toBe(120_000)
	})

	it("interleaves real asynchrony with virtual sleeps", async () => {
		const clock = new VirtualClock()

		const work = (async () => {
			await realDelay(20)
			await clock.sleep(30_000)
			await realDelay(20)

			return clock.now()
		})()

		await expect(clock.runUntilSettled(work)).resolves.toBe(30_000)
	})

	it("still reports genuinely stuck work, rather than hanging", async () => {
		const clock = new VirtualClock()

		const stuck = new Promise<never>(() => {})

		await expect(clock.runUntilSettled(stuck)).rejects.toThrow(/blocked on something this clock does not drive/)
	}, 30_000)

	it("measures its budget with performance.now, not the fakeable Date", async () => {
		// Consumers freeze `Date` inside their describe blocks, so a budget reading `Date.now()`
		// would never advance and genuinely stuck work would hang instead of reporting.
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))

		try {
			const clock = new VirtualClock()

			await expect(clock.runUntilSettled(new Promise<never>(() => {}))).rejects.toThrow(
				/blocked on something this clock does not drive/
			)
		} finally {
			vi.useRealTimers()
		}
	}, 30_000)

	it("does not busy-spin while waiting — the spin starved the I/O it waited for", async () => {
		const clock = new VirtualClock()

		let ticks = 0

		const counter = setInterval(() => {
			ticks++
		}, 5)

		try {
			await clock.runUntilSettled(realDelay(120))
		} finally {
			clearInterval(counter)
		}

		// A 5ms interval over ~120ms should fire ~24 times, and a settle loop that hogs the
		// event loop with back-to-back `setImmediate` turns starves it well below that.
		expect(ticks).toBeGreaterThanOrEqual(8)
	})
})
