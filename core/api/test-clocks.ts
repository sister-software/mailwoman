/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Deterministic {@linkcode ClockLike} implementations shared by the `core/api` suites and by
 *   downstream clients' tests (`filer/sdk/sec-client.test.ts`).
 *
 *   Lifted from `98c4dda1:filer/sdk/sec-client.test.ts`, where the two-clock split was worked out: a
 *   naive clock is fine for sequential assertions and actively MASKS concurrency bugs, so anything
 *   testing how concurrent waiters interleave needs the deadline-ordered one.
 */

import type { ClockLike } from "./clock.ts"

/**
 * Run every queued microtask to quiescence. A `setImmediate` is scheduled behind the entire microtask queue, so
 * awaiting one guarantees any in-flight promise chain has settled as far as it can without more real time.
 */
export function drainMicrotasks(): Promise<void> {
	return new Promise<void>((resolve) => {
		setImmediate(resolve)
	})
}

/**
 * A {@linkcode ClockLike} whose `sleep()` bumps `now()` and resolves immediately.
 */
export interface FakeClock extends ClockLike {
	/**
	 * Every `ms` value awaited via `sleep`, in call order.
	 */
	sleepCalls: number[]
	/**
	 * Advance the clock WITHOUT recording a `sleepCalls` entry — simulates wall-clock time passing between two calls
	 * (e.g. "a day later") without the code under test having awaited anything.
	 */
	advance(ms: number): void
}

/**
 * A simple, immediately-resolving fake clock. Fine for every SEQUENTIAL assertion (nothing racing the clock), but NOT
 * sufficient for a concurrency test — see {@linkcode VirtualClock}.
 */
export function createFakeClock(startAt = 0): FakeClock {
	let current = startAt
	const sleepCalls: number[] = []

	return {
		sleepCalls,
		now: () => current,
		sleep: async (ms: number) => {
			sleepCalls.push(ms)
			current += ms
		},
		advance: (ms: number) => {
			current += ms
		},
	}
}

/**
 * A virtual-time clock that resolves concurrent `sleep()`s ONE AT A TIME, strictly in deadline order, only when
 * explicitly driven via {@linkcode VirtualClock.advance} — unlike {@linkcode createFakeClock}, which bumps `now()`
 * synchronously the INSTANT `sleep()` is called (fine when nothing else races the clock, but not a faithful model of "N
 * callers all waiting on the same deadline").
 *
 * This fidelity is exactly what a pacing regression needs: a coarser clock that resolves every same-deadline sleeper
 * "at once" cannot distinguish a fixed pacer from a broken one — under such a clock BOTH let a whole cohort through
 * together, because the naive clock's call-time (not wake-time) mutation of `now()` interleaves in a way that masks the
 * bug. Here each pending `sleep()` resolves only when `advance()` reaches its deadline, and the woken continuation
 * (which may register a NEW `sleep()`, pushing its own deadline further out) runs to completion before the next
 * same-deadline sleeper is resolved — reproducing how N real, independent timers settle.
 */
export class VirtualClock implements ClockLike {
	#now = 0
	#pending: Array<{ deadline: number; resolve: () => void }> = []
	readonly sleepCalls: number[] = []

	public now(): number {
		return this.#now
	}

	public sleep(ms: number): Promise<void> {
		this.sleepCalls.push(ms)

		return new Promise<void>((resolve) => {
			this.#pending.push({ deadline: this.#now + ms, resolve })
		})
	}

	/**
	 * Advance virtual time to `now() + ms`, waking every pending `sleep()` due at or before that instant — one at a time,
	 * earliest deadline first (ties broken by registration order), draining the microtask queue after each wakeup so the
	 * woken continuation runs to quiescence before the next deadline is considered.
	 *
	 * The drain is a `setImmediate` (a MACROTASK), not a fixed number of `await Promise.resolve()` turns. A woken
	 * continuation that runs through a library's own promise chain — Axios's request/response interceptors, say — needs
	 * more microtask turns than any hardcoded count, and coming up short lets the clock run ahead of an in-flight
	 * dispatch: the request then records a LATER deadline's timestamp, and two dispatches appear to share an instant when
	 * they didn't.
	 */
	public async advance(ms: number): Promise<void> {
		const target = this.#now + ms

		for (;;) {
			const earliestIndex = this.#earliestDueIndex(target)

			if (earliestIndex === -1) break

			const [due] = this.#pending.splice(earliestIndex, 1)

			this.#now = due!.deadline
			due!.resolve()

			await drainMicrotasks()
		}

		this.#now = target
	}

	#earliestDueIndex(target: number): number {
		let earliestIndex = -1

		for (let i = 0; i < this.#pending.length; i++) {
			if (this.#pending[i]!.deadline > target) continue

			if (earliestIndex === -1 || this.#pending[i]!.deadline < this.#pending[earliestIndex]!.deadline) {
				earliestIndex = i
			}
		}

		return earliestIndex
	}
}

/**
 * The maximum number of `timestamps` falling within any sliding window of `windowMs`, using a trailing half-open window
 * `(anchor - windowMs, anchor]` at each timestamp — the conventional "requests in the last N ms" definition.
 */
export function maxCountInSlidingWindow(timestamps: number[], windowMs: number): number {
	let max = 0

	for (const anchor of timestamps) {
		const count = timestamps.filter((t) => t > anchor - windowMs && t <= anchor).length

		max = Math.max(max, count)
	}

	return max
}
