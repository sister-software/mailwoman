/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for {@linkcode RequestPacer} — the strict minimum-interval pacer.
 */

import type { ClockLike } from "@mailwoman/core/api"
import { RequestPacer } from "@mailwoman/core/api/pacer"
import {
	createFakeClock,
	drainMicrotasks,
	maxCountInSlidingWindow,
	VirtualClock,
} from "@mailwoman/core/api/test-clocks"
import { describe, expect, it } from "vitest"

function makeRecordedAcquire(pacer: RequestPacer, clock: ClockLike, grantTimes: number[]): () => Promise<void> {
	return async () => {
		await pacer.acquire()
		grantTimes.push(clock.now())
	}
}

describe("RequestPacer", () => {
	it("rejects a zero or non-finite interval instead of silently not pacing", () => {
		expect(() => new RequestPacer(0)).toThrow(/greater than 0/)
		expect(() => new RequestPacer(-5)).toThrow(/greater than 0/)
		expect(() => new RequestPacer(Number.POSITIVE_INFINITY)).toThrow(/finite/)
		expect(() => new RequestPacer(Number.NaN)).toThrow(/finite/)
	})

	it("grants the first call immediately and spaces every later call by the configured interval", async () => {
		const clock = createFakeClock()
		const pacer = new RequestPacer(100, clock)

		await pacer.acquire()
		expect(clock.sleepCalls).toHaveLength(0)

		await pacer.acquire()
		expect(clock.sleepCalls).toEqual([100])

		await pacer.acquire()
		expect(clock.sleepCalls).toEqual([100, 100])
	})

	it("does not accumulate a burst backlog after an idle period", async () => {
		// Mutation-proves the `Math.max(#nextGrantAt, now)` recency clamp: without it,
		// a long-stale `#nextGrantAt` lets every call after an idle period through immediately.
		const clock = createFakeClock()
		const pacer = new RequestPacer(100, clock)

		await pacer.acquire()

		clock.advance(10_000)

		const grantTimes: number[] = []

		for (let i = 0; i < 5; i++) {
			await pacer.acquire()
			grantTimes.push(clock.now())
		}

		expect(grantTimes).toEqual([10_000, 10_100, 10_200, 10_300, 10_400])
	})

	// `VirtualClock` (not the simpler `createFakeClock`) is required: the property under
	// test is how concurrent waiters interleave when woken, and a clock that resolves every
	// same-deadline sleeper at once cannot tell a fixed pacer from a broken one.
	it("paces N concurrent acquire() calls strictly one interval apart — no cohort ever shares an instant", async () => {
		const INTERVAL_MS = 100
		const TOTAL_CALLS = 40
		const EXPECTED_PER_SECOND = 10

		const clock = new VirtualClock()
		const pacer = new RequestPacer(INTERVAL_MS, clock)
		const grantTimes: number[] = []
		const recordedAcquire = makeRecordedAcquire(pacer, clock, grantTimes)

		// `Array.from`'s mapper runs synchronously for every index, so this genuinely fans
		// out 40 concurrent `acquire()` calls with no intervening async I/O.
		const pending = Array.from({ length: TOTAL_CALLS }, () => recordedAcquire())

		// The first call resolves without sleeping, but awaiting an already-resolved promise
		// still defers its `push` to the microtask queue, so flush it before driving the clock —
		// otherwise `advance()`'s own first internal await would flush it after `now()` has left t=0.
		await drainMicrotasks()

		await clock.advance((TOTAL_CALLS - 1) * INTERVAL_MS)
		await Promise.all(pending)

		expect(grantTimes).toHaveLength(TOTAL_CALLS)

		const expectedGrants = Array.from({ length: TOTAL_CALLS }, (_, i) => i * INTERVAL_MS)

		expect(grantTimes).toEqual(expectedGrants)
		expect(new Set(grantTimes).size).toBe(TOTAL_CALLS)

		expect(maxCountInSlidingWindow(grantTimes, 1000)).toBe(EXPECTED_PER_SECOND)
	})

	it("holds the interval when a serial run is followed by a concurrent fan-out", async () => {
		const INTERVAL_MS = 50
		const SERIAL_CALLS = 3
		const FANOUT_CALLS = 6

		const clock = new VirtualClock()
		const pacer = new RequestPacer(INTERVAL_MS, clock)
		const grantTimes: number[] = []
		const recordedAcquire = makeRecordedAcquire(pacer, clock, grantTimes)

		// `VirtualClock.advance` mutates `now()` before its first internal await flushes the microtask
		// queue, so an already-resolved `acquire()` whose continuation is still queued would record
		// the post-advance time; flush to quiescence first at every point where that could happen.
		for (let i = 0; i < SERIAL_CALLS; i++) {
			const pending = recordedAcquire()

			await drainMicrotasks()
			await clock.advance(INTERVAL_MS)
			await pending
		}

		const fanout = Array.from({ length: FANOUT_CALLS }, () => recordedAcquire())

		await drainMicrotasks()
		await clock.advance(FANOUT_CALLS * INTERVAL_MS)
		await Promise.all(fanout)

		const gaps = grantTimes.slice(1).map((time, index) => time - grantTimes[index]!)

		expect(grantTimes).toHaveLength(SERIAL_CALLS + FANOUT_CALLS)
		expect(gaps.every((gap) => gap >= INTERVAL_MS)).toBe(true)
	})
})
