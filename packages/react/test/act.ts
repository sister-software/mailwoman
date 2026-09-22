/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Wrap shared test helpers so async React updates happen inside `act()`.
 *
 * - `userEvent.*`: run each interaction in `act()` and drain one extra tick.
 * - `vi.waitFor`: poll with a fresh `act()` each round.
 *
 * Wrappers are installed once on shared singletons and are idempotent.
 */

import { act } from "react"
import { vi } from "vitest"
import { userEvent } from "vitest/browser"

/**
 * Marker to avoid double-wrapping methods.
 */
const WRAPPED = Symbol.for("mailwoman.react.act-wrapped")

type AnyFn = (...args: unknown[]) => unknown

type TaggableFn = AnyFn & { [WRAPPED]?: true }

/**
 * Run `fn` in `act()` and return its resolved value.
 */
async function inAct<T>(fn: () => Promise<T>): Promise<T> {
	let result: T

	await act(async () => {
		result = await fn()
	})

	return result!
}

/**
 * Drain one macrotask tick.
 */
function nextTick(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, 0)
	})
}

/**
 * Wrap `userEvent` methods so each call runs in `act()` plus one trailing tick.
 */
function wrapUserEvent(): void {
	// Cast for key-based iteration and reassignment.
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

/**
 * Defaults matching Vitest `vi.waitFor`.
 */
const DEFAULT_WAIT_TIMEOUT = 1000
const DEFAULT_WAIT_INTERVAL = 50

/**
 * Poll `callback` until it passes or times out.
 * Advances React in `act()` between tries.
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
			// Call sync first.
			// Only a real thenable is awaited.
			const result = callback()

			const isThenable =
				result !== null && typeof result === "object" && typeof (result as { then?: unknown }).then === "function"

			const value = isThenable ? await (result as Promise<T>) : (result as T)

			// Drain one more tick in act for trailing updates.
			await act(async () => {
				await new Promise((resolve) => {
					setTimeout(resolve, 0)
				})
			})

			return value
		} catch (error) {
			lastError = error
		}

		if (Date.now() >= deadline) throw lastError

		// Wait inside act between retries.
		await act(async () => {
			await new Promise((resolve) => {
				setTimeout(resolve, interval)
			})
		})
	}
}

/**
 * Replace `vi.waitFor` with the act-aware poll.
 */
function wrapWaitFor(): void {
	const original = vi.waitFor as TaggableFn

	if (original[WRAPPED]) return

	const wrapped = actWaitFor as TaggableFn
	wrapped[WRAPPED] = true
	vi.waitFor = wrapped as typeof vi.waitFor
}

/**
 * Advance real time inside `act()`.
 * Use for waits that cannot use `vi.waitFor`.
 */
export async function actDelay(ms = 0): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => {
			setTimeout(resolve, ms)
		})
	})
}

/**
 * Install wrappers on shared `userEvent` and `vi` singletons.
 * Safe to call more than once.
 */
export function installActWrappers(): void {
	wrapUserEvent()
	wrapWaitFor()
}
