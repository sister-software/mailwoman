/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The ONE act() lever for the browser-mode suite.
 *
 *   The components under test do async state updates (autocomplete debounce timers, runtime-load and
 *   parse promises, the clipboard write + its transient "copied" flag). A test triggers an interaction
 *   and then asserts, but the resulting `setState` settles in a LATER microtask/timer — outside any
 *   `act()` scope — so React logs "An update to <X> inside a test was not wrapped in act(...)".
 *
 *   Rather than sprinkle `await act(async () => …)` across ~150 call sites, we wrap the two APIs every
 *   test already routes through, ONCE, in place:
 *
 *     • `userEvent` (from `@vitest/browser/context`) — the interaction surface. Each method now runs its
 *       DOM event inside `act()` and then drains one macrotask tick, still inside the same `act()` scope,
 *       so a fire-and-forget `onClick` handler (e.g. `useClipboard`'s `copy()`, whose `setCopied(true)`
 *       lands after the click promise resolves — decoupled from the click) is captured too.
 *
 *     • `vi.waitFor` (from `vitest`) — the settle surface. Reimplemented as a poll that completes ONE
 *       full `act()` per iteration and checks the assertion synchronously between iterations. Completing
 *       a fresh act each round is what lets an effect CHAIN advance (a held-open act swallows the passive
 *       effect flushes between steps — e.g. `useDemoRuntime`'s manifest → assets → ready effects would
 *       stall). Because the ONLY code outside act is the synchronous callback invocation (no await, so
 *       no microtask/timer can interleave there), every async `setState` — a debounce firing, a runtime
 *       promise resolving, a parse completing — lands inside an act tick.
 *
 *   Both are singleton objects shared by every importer via the ES-module live binding, so mutating
 *   their methods here — from the setup file, before any test runs — makes every existing
 *   `userEvent.*` / `vi.waitFor` call act-aware with no per-test change. `installActWrappers()` is
 *   idempotent (guarded) so a stray double-import can't double-wrap.
 */

import { userEvent } from "@vitest/browser/context"
import { act } from "react"
import { vi } from "vitest"

/** Marker so a repeat import can't wrap an already-wrapped method (which would nest act() pointlessly). */
const WRAPPED = Symbol.for("mailwoman.react.act-wrapped")

type AnyFn = (...args: unknown[]) => unknown
type TaggableFn = AnyFn & { [WRAPPED]?: true }

/** Run `fn` inside act() and return its resolved value — the shared primitive both wrappers build on. */
async function inAct<T>(fn: () => Promise<T>): Promise<T> {
	let result: T

	await act(async () => {
		result = await fn()
	})

	return result!
}

/** One drained macrotask tick — lets a fire-and-forget handler's trailing microtasks flush inside act(). */
function nextTick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Wrap every function-valued method on `userEvent` so the interaction — and one trailing tick — run inside act(). The
 * trailing tick is what captures updates decoupled from the event (the clipboard case); a debounced update lands later
 * still and is caught by the act-wrapped `vi.waitFor` the test awaits next.
 */
function wrapUserEvent(): void {
	const target = userEvent as unknown as Record<string, TaggableFn>

	for (const key of Object.keys(target)) {
		const original = target[key]

		if (typeof original !== "function" || original[WRAPPED]) continue

		const bound = original.bind(userEvent) as AnyFn

		const wrapped: TaggableFn = async (...args: unknown[]) =>
			inAct(async () => {
				const result = await bound(...args)
				await nextTick()

				return result
			})

		wrapped[WRAPPED] = true
		target[key] = wrapped
	}
}

/** Vitest's own `vi.waitFor` defaults (see its `WaitForOptions`) — reproduced so the poll matches. */
const DEFAULT_WAIT_TIMEOUT = 1000
const DEFAULT_WAIT_INTERVAL = 50

/**
 * Poll `callback` until it stops throwing (or `timeout` elapses), advancing React inside act() between tries. Each
 * iteration awaits a full `act()` (draining that round's microtasks + a timer tick), so effect chains flush a step at a
 * time; the callback then runs SYNCHRONOUSLY outside act — the only out-of-act code, and being sync it offers no point
 * for a stray update to escape the act scope.
 *
 * Drop-in for `vi.waitFor` over this suite's usage (synchronous assertion callbacks). An async callback is still
 * awaited, but none of the tests here pass one.
 */
async function actWaitFor<T>(
	callback: () => T | Promise<T>,
	options?: number | { timeout?: number; interval?: number }
): Promise<T> {
	const timeout = typeof options === "number" ? options : (options?.timeout ?? DEFAULT_WAIT_TIMEOUT)
	const interval = typeof options === "number" ? DEFAULT_WAIT_INTERVAL : (options?.interval ?? DEFAULT_WAIT_INTERVAL)
	const deadline = Date.now() + timeout
	let lastError: unknown

	for (;;) {
		try {
			// Call synchronously and only `await` a genuinely-thenable result. `await`-ing a plain value
			// still yields a microtask, and a component promise queued behind it would fire setState in
			// that gap — outside act. None of this suite's callbacks are async, so the sync path is the norm.
			const result = callback()
			const isThenable =
				result !== null && typeof result === "object" && typeof (result as { then?: unknown }).then === "function"
			const value = isThenable ? await (result as Promise<T>) : (result as T)

			// The condition is met, but an intermediate assertion (wait for X while Y is still resolving —
			// a parse that fills components before the place resolves, a runtime whose subject lands before a
			// follow-on) can leave a promise in flight. Drain one more tick INSIDE act so that trailing
			// setState settles in-scope instead of firing during the caller's `await` resume gap.
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0))
			})

			return value
		} catch (error) {
			lastError = error
		}

		if (Date.now() >= deadline) throw lastError

		// All waiting happens inside act(): the pending updates for this round settle in-scope, and the
		// fresh act completes so the next effect in a chain gets flushed before the next check.
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, interval))
		})
	}
}

/** Swap `vi.waitFor` for the act-advancing poll above. */
function wrapWaitFor(): void {
	const original = vi.waitFor as TaggableFn

	if (original[WRAPPED]) return

	const wrapped = actWaitFor as unknown as TaggableFn
	wrapped[WRAPPED] = true
	vi.waitFor = wrapped as unknown as typeof vi.waitFor
}

/**
 * Advance `ms` of real time INSIDE act(). For the rare "wait, then assert nothing happened" case a negative assertion
 * can't route through `vi.waitFor` (which waits for a condition to BECOME true): the digit-leading autocomplete test
 * waits past the debounce to prove the fetcher never fired, and the debounce's own `setDebouncedValue` + the abstaining
 * effect still run during that wait — so the wait itself must hold an act scope. Use this instead of a bare `await new
 * Promise(setTimeout)`.
 */
export async function actDelay(ms = 0): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms))
	})
}

/** Install the act() wrappers on the shared `userEvent` / `vi` singletons. Idempotent. */
export function installActWrappers(): void {
	wrapUserEvent()
	wrapWaitFor()
}
