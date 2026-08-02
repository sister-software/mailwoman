/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   {@linkcode VirtualClock.runUntilSettled}'s stuck-work guard.
 *
 *   The guard used to budget IDLE EVENT-LOOP TURNS (1000 of them), on the stated assumption that "a
 *   real `readFile` resolves in a handful of turns". Turns are not time. Each idle turn is a
 *   `setImmediate` round-trip costing microseconds, so the whole 1000-turn budget expires in a few
 *   milliseconds — while the real I/O being waited on takes tens. On an unloaded machine the race
 *   happened to go the right way; under load it did not, and the guard fired on WORKING code:
 *
 *     Error: VirtualClock.runUntilSettled: no pending sleep and no progress for 1000 turns at
 *            t=4368. The work is blocked on something this clock does not drive.
 *
 *   Observed 2026-08-02 on the lab (load 15.25) and then on a hosted GitHub runner, in
 *   `filer/sdk/sec-client.test.ts` and `bdc/sdk/client.test.ts`. The spin made it worse: 1000 tight
 *   `setImmediate` turns compete with the very I/O they are waiting for.
 *
 *   The budget is real elapsed time now, measured with `performance.now()`. NOT `Date.now()` —
 *   consumers run under `vi.useFakeTimers({ toFake: ["Date"] })`, which freezes `Date` but leaves
 *   `performance` and `setTimeout` real, so a Date-based budget would never expire and the guard
 *   would hang exactly where it is supposed to report.
 */

import { describe, expect, it, vi } from "vitest"

import { VirtualClock } from "./test-clocks.ts"

/**
 * Resolve after `ms` of REAL time, via a real macrotask the virtual clock does not drive. This is what a `readFile`
 * looks like to `runUntilSettled`: progress it cannot see and cannot schedule.
 */
function realDelay(ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms)
	})
}

describe("VirtualClock.runUntilSettled — the stuck-work guard", () => {
	it("waits out real I/O that outlasts any turn budget", async () => {
		const clock = new VirtualClock()

		// 50ms of real time is thousands of idle setImmediate turns. Under the turn-budgeted guard
		// this threw; the work was never stuck, the budget was just denominated in the wrong unit.
		await expect(clock.runUntilSettled(realDelay(50))).resolves.toBeUndefined()
	})

	it("still drives virtual sleeps to completion", async () => {
		const clock = new VirtualClock()

		const work = (async () => {
			await clock.sleep(60_000)
			await clock.sleep(60_000)

			return clock.now()
		})()

		// Virtual time jumps; no real 120s elapses.
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

		// A promise nothing will ever resolve — the case the guard exists for.
		const stuck = new Promise<never>(() => {})

		await expect(clock.runUntilSettled(stuck)).rejects.toThrow(/blocked on something this clock does not drive/)
	}, 30_000)

	it("measures its budget with performance.now, not the fakeable Date", async () => {
		// Consumers freeze Date inside their describe blocks. If the budget read Date.now() it would
		// never advance there, and genuinely stuck work would hang instead of reporting.
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

		// A 5ms interval over ~120ms should fire ~24 times. A settle loop that hogs the event loop
		// with back-to-back setImmediate turns starves it well below that.
		expect(ticks).toBeGreaterThanOrEqual(8)
	})
})
