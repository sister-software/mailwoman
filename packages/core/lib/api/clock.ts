/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The injectable time source every timing-sensitive part of {@linkcode APIClient} reads through.
 *
 *   The pacing and backoff suites inject the clock so they stay deterministic and finish in
 *   milliseconds instead of sleeping on the wall clock.
 *   clock — a rate-limit test that actually waits 100ms per grant costs 4s for a 40-call fan-out and
 *   is flaky under CI load. the same test against an injected clock is exact and instant.
 *
 *   Deliberately not `node:timers/promises`: `core/api` reaches a browser bundle (`docs`'s
 *   `DashboardMap` imports `@mailwoman/cartographer`, which barrels `tiles/api.ts`, which imports
 *   `@mailwoman/core/api`), and webpack 5 refuses to resolve a `node:`-prefixed specifier for the
 *   web target. The global `setTimeout` is available on every runtime this package ships to.
 */

/**
 * A minimal, injectable time source.
 *
 * Anything in this package that would otherwise call `Date.now()` or `setTimeout` directly
 * reads through this instead, so tests can drive time deterministically.
 */
export interface ClockLike {
	/**
	 * The current time, in milliseconds.
	 *
	 * Same interface as `Date.now()`.
	 */
	now(): number
	/**
	 * Resolve after at least `ms` milliseconds of this clock's time.
	 */
	sleep(ms: number): Promise<void>
}

/**
 * The real-time {@linkcode ClockLike}, used whenever a caller doesn't inject one.
 */
export const systemClock: ClockLike = {
	now: () => Date.now(),
	sleep: (ms) =>
		new Promise<void>((resolve) => {
			setTimeout(resolve, ms)
		}),
}
