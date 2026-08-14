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
 * How much REAL time {@linkcode VirtualClock.runUntilSettled} tolerates with nothing pending before declaring the work
 * stuck. Finite, so a genuinely blocked test reports what happened instead of timing out.
 *
 * This used to be a budget of 1000 idle event-loop TURNS, on the stated assumption that "a real `readFile` resolves in
 * a handful of turns". Turns are not time: an idle turn is a `setImmediate` round-trip costing microseconds, so the
 * whole budget expired in single-digit milliseconds while the I/O it was waiting for took tens. On an unloaded machine
 * the race happened to go the right way. Under load it did not, and the guard fired on WORKING code — observed
 * 2026-08-02 on the lab at load 15.25 and then on a hosted GitHub runner, in `filer/sdk/sec-client.test.ts` and
 * `bdc/sdk/client.test.ts`.
 *
 * Measured with `performance.now()`, NOT `Date.now()`: consumers run under `vi.useFakeTimers({ toFake: ["Date"] })`,
 * which freezes `Date` while leaving `performance` and `setTimeout` real. A Date-based budget would never expire inside
 * those blocks, so genuinely stuck work would hang exactly where this is supposed to report it.
 */
const IDLE_BUDGET_MS = 5000

/**
 * Idle turns to spin on {@linkcode drainMicrotasks} before backing off to real sleeps.
 *
 * The spin is the fast path — work that is one promise-chain away settles within a few turns and should not pay a
 * timer. Past that the wait is on something real, and continuing to spin actively HARMS it: back-to-back `setImmediate`
 * turns monopolize the event loop and starve the very I/O the loop is waiting for. That feedback loop is why the old
 * guard got worse exactly when the machine was busiest.
 */
const IDLE_SPIN_TURNS = 50

/**
 * Real backoff between idle polls once {@linkcode IDLE_SPIN_TURNS} is exhausted.
 */
const IDLE_BACKOFF_MS = 1

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
 * Yield the event loop for `ms` of REAL time. Used only by {@linkcode VirtualClock.runUntilSettled}'s idle backoff, to
 * let pending real I/O actually be serviced instead of competing with a `setImmediate` spin.
 */
function realDelay(ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms)
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

	/**
	 * Drive `work` to completion, jumping virtual time to the next pending deadline whenever the REAL event loop goes
	 * idle.
	 *
	 * {@linkcode advance} alone is not enough once the code under test interleaves virtual sleeps with real asynchrony —
	 * a paced client whose gate sits downstream of an on-disk cache spends several real event-loop turns in `readFile`
	 * before it ever registers its `sleep()`. A caller that drains once and then advances finds nothing pending, jumps
	 * the clock past the deadlines that are registered a moment later, and the test hangs. This polls instead: drain, and
	 * if any sleep is pending, advance to the earliest deadline; if none is, yield and look again.
	 *
	 * Throws rather than hanging when the work neither settles nor schedules anything for {@linkcode IDLE_BUDGET_MS} of
	 * REAL time — a diagnosable failure beats a test-timeout stack trace pointing at the `it()`.
	 */
	public async runUntilSettled<T>(work: Promise<T>): Promise<T> {
		let settled = false

		const observed = work.then(
			(value) => {
				settled = true

				return value
			},
			(error: unknown) => {
				settled = true

				throw error
			}
		)

		// Keep the rejection from surfacing as an unhandled rejection while we drive the clock; the real
		// one is still delivered to whoever awaits the returned promise.
		observed.catch(() => undefined)

		let idleTurns = 0
		let idleSince: number | null = null

		for (;;) {
			await drainMicrotasks()

			// `settled` is flipped by the callbacks above, not by this loop body — hence the explicit
			// break rather than a loop condition (which reads as unmodified to a static analyzer).
			if (settled) break

			const earliest = this.#earliestPendingDeadline()

			if (earliest === null) {
				idleSince ??= performance.now()

				idleTurns++

				const idleFor = performance.now() - idleSince

				if (idleFor > IDLE_BUDGET_MS) {
					throw new Error(
						`VirtualClock.runUntilSettled: no pending sleep and no progress for ${Math.round(idleFor)}ms of ` +
							`real time at t=${this.#now}. The work is blocked on something this clock does not drive.`
					)
				}

				// Past the spin window the wait is on something real. Back off so it can be serviced —
				// spinning here starves the I/O we are waiting for, which is why the old turn-budgeted
				// guard failed hardest on the busiest machines.
				if (idleTurns > IDLE_SPIN_TURNS) {
					await realDelay(IDLE_BACKOFF_MS)
				}

				continue
			}

			idleTurns = 0
			idleSince = null

			await this.advance(Math.max(earliest - this.#now, 0))
		}

		return observed
	}

	#earliestPendingDeadline(): number | null {
		let earliest: number | null = null

		for (const { deadline } of this.#pending) {
			if (earliest === null || deadline < earliest) {
				earliest = deadline
			}
		}

		return earliest
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
