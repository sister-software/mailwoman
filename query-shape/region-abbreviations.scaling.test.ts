/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `computeQueryShape` must stay LINEAR in input size.
 *
 *   Every parse pays this stage before the model is touched, and its inputs (tokens, segments) both grow with
 *   input length — so any routine that pairs them is quadratic, and a 1 MB query costs minutes instead of
 *   milliseconds. `region-abbreviations.ts` is the one that has to walk both.
 *
 *   No correctness test can catch that: a quadratic and a linear implementation return identical results, so
 *   only the growth CURVE distinguishes them. Hence a ratio assertion, and hence a ratio rather than a
 *   millisecond budget — pinning absolute time makes a timing test a CI flake, while the ratio is the thing a
 *   complexity regression actually changes. Quadratic doubles to ~4x, linear to ~2x; the 3x threshold sits
 *   clear of a loaded runner without letting the real failure through.
 */

import { computeQueryShape } from "@mailwoman/query-shape"
import { expect, test } from "vitest"

/**
 * One "City, ST ZIP" record. Repeating it grows segments and tokens together, which is the pairing that made the
 * original nested.
 */
const UNIT = "123 Main St, Springfield, IL 62701, "

/**
 * Timing samples per size. Three is enough for the minimum to skip a transient spike without making the test slow.
 */
const TIMING_SAMPLES = 3

/**
 * Best of {@link TIMING_SAMPLES} runs.
 *
 * Contention can only ever ADD time to a sample, never remove it, so the minimum is the run least polluted by whatever
 * else the machine was doing. A mean or a single sample inherits every load spike, which on a shared CI runner is the
 * difference between measuring the algorithm and measuring the neighbours.
 */
function timeAt(reps: number): number {
	const input = UNIT.repeat(reps)
	// Warm first — a cold JIT on the smaller sample would inflate the ratio and fail spuriously.
	computeQueryShape(input)

	const start = performance.now()

	computeQueryShape(input)

	return performance.now() - start
}

function bestOf(chars: number): number {
	let best = Number.POSITIVE_INFINITY

	for (let i = 0; i < TIMING_SAMPLES; i++) {
		best = Math.min(best, timeAt(chars))
	}

	return best
}

test("computeQueryShape stays linear as segment count doubles", () => {
	// Large enough that fixed overheads do not dominate the ratio.
	const small = bestOf(4000)
	const large = bestOf(8000)
	const ratio = large / Math.max(small, 0.001)

	expect(
		ratio,
		`doubling the input multiplied the cost by ${ratio.toFixed(2)}x (${small.toFixed(1)}ms -> ${large.toFixed(1)}ms). ` +
			`Linear is ~2x; quadratic is ~4x. Something in the query-shape stage is scanning pairs again — see ` +
			`region-abbreviations.ts for the two-pointer merge this replaced.`
	).toBeLessThan(3)
})
