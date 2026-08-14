/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Strict minimum-interval request pacing for {@linkcode APIClient}.
 *
 *   Lifted verbatim (modulo the SEC-specific rate clamp, which now lives at the SEC client's own call
 *   site) from `98c4dda1:filer/sdk/sec-client.ts`, where the design was settled over two review rounds
 *   and verified across eight arrival shapes — fan-out, interleaved, serial-plus-fanout, multi-burst,
 *   mid-refill, idle-then-burst, and a 60-call run at 50/s — under an injected clock.
 */

import { type ClockLike, systemClock } from "./clock.ts"

/**
 * A strict-interval request pacer: grants are spaced AT LEAST `intervalMs` apart, with NO burst allowance beyond the
 * very first grant. {@linkcode RequestPacer.acquire} resolves immediately for the first call after construction (or
 * after any idle gap), and every call within one interval of the previous grant waits out the remainder of it.
 *
 * WHY NOT A TOKEN BUCKET: a token bucket with capacity C admits up to `C + rate * 1s` requests within any sliding
 * one-second window — there is NO non-zero capacity that honors a FLAT rate cap, only an average one. The bucket this
 * replaced started full (a one-time startup burst, by design) but ALSO refilled to full after any idle gap, so a fresh
 * burst recurred every time a crawl paused and resumed — measured at 20 grants inside one 1000ms window against a 10/s
 * ceiling (2x). Upstreams that publish a flat rate (SEC EDGAR's 10 req/s, verified enforced) and actively police it
 * need the FLAT guarantee, at the cost of the first-call-of-a-burst latency a bucket would have avoided.
 *
 * FAIRNESS (deliberately not addressed): under concurrent contention (N callers racing `acquire()` in the same
 * synchronous turn), grants are issued in whatever order the synchronous reservation happens to run in. This never
 * affects the RATE — every grant is still exactly `intervalMs` after the last — only which specific caller waits how
 * long under backlog. A caller needing FIFO fairness would need a real queue on top of this.
 */
export class RequestPacer {
	readonly #intervalMs: number
	readonly #clock: ClockLike
	#nextGrantAt: number

	/**
	 * @param intervalMs Minimum milliseconds between two grants. Values `<= 0` are rejected — a zero-interval pacer would
	 *   never actually pace, and silently accepting one would make a misconfigured caller look throttled when it isn't.
	 * @param clock Time source. Defaults to {@linkcode systemClock}.
	 */
	constructor(intervalMs: number, clock: ClockLike = systemClock) {
		if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
			throw new RangeError(
				`RequestPacer: intervalMs must be a finite number greater than 0 (received ${intervalMs}). A pacer with a ` +
					"zero or non-finite interval cannot enforce a rate; construct one only when you actually want pacing."
			)
		}

		this.#intervalMs = intervalMs
		this.#clock = clock
		this.#nextGrantAt = clock.now()
	}

	/**
	 * The configured minimum spacing between grants, in milliseconds.
	 */
	public get intervalMs(): number {
		return this.#intervalMs
	}

	/**
	 * Resolve once this call's turn comes up: immediately for the first call (or after any idle gap), or exactly
	 * `intervalMs` after the previous grant otherwise.
	 *
	 * The grant time is reserved SYNCHRONOUSLY, before any `await` — `#nextGrantAt` is read AND bumped in the same
	 * synchronous step that computes this call's own wait. This is load-bearing, not cosmetic: moving the `#nextGrantAt`
	 * update to after the `await` (i.e. "compute the wait, sleep, then update state") reopens the concurrency bug this
	 * pacer exists to close — N callers invoked in the same synchronous turn would all read the SAME stale `#nextGrantAt`
	 * before any of them updates it, compute the SAME wait, and all be released together instead of one interval apart.
	 *
	 * `Math.max(#nextGrantAt, now)` is equally load-bearing: without it, a long idle gap leaves `#nextGrantAt` stuck in
	 * the past, and every call after the idle would compute a negative/zero wait forever (the increment-by-one-interval
	 * never catches up to a `now` that's run far ahead) — pacing would silently stop working after any idle period.
	 *
	 * Both are mutation-proved in `pacer.test.ts`.
	 *
	 * REAL-CLOCK CAVEAT, measured rather than assumed: the guarantee is on the CLOCK's timeline. Grant instants are
	 * scheduled exactly `intervalMs` apart, but the continuation that actually issues the request runs whenever the event
	 * loop gets to it, which on real timers is 0-2ms after the deadline. A grant that lands 1ms late shifts toward the
	 * following window, so a sliding-second count over the OBSERVED dispatch times reads 11 rather than 10 at a 100ms
	 * interval (measured 3/3 runs of a 40-call fan-out; the preceding second correspondingly holds 9, and the long-run
	 * rate is exactly at the cap). A caller that needs a hard sliding-window ceiling with no jitter headroom should pace
	 * fractionally under the published rate rather than exactly at it.
	 */
	public async acquire(): Promise<void> {
		const now = this.#clock.now()
		const grantAt = Math.max(this.#nextGrantAt, now)

		this.#nextGrantAt = grantAt + this.#intervalMs

		const waitMs = grantAt - now

		if (waitMs > 0) {
			await this.#clock.sleep(Math.ceil(waitMs))
		}
	}
}
