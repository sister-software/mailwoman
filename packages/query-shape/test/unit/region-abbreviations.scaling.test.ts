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
 * Timing samples per size. Five keeps the minimum honest against back-to-back load spikes (three let one through on
 * 2026-08-05 — see the threshold note below) without making the test slow.
 */
const TIMING_SAMPLES = 5

/**
 * Contention can only ever ADD time to a sample, never remove it, so the minimum is the run least polluted by whatever
 * else the machine was doing. A mean or a single sample inherits every load spike, which on a shared CI runner is the
 * difference between measuring the algorithm and measuring the neighbours.
 */
function timeAt(input: string): number {
	const start = performance.now()

	computeQueryShape(input)

	return performance.now() - start
}

/**
 * Sample both sizes INTERLEAVED (small, large, small, large, …) rather than all-small-then-all-large: runner load and
 * thermal state drift over the test's lifetime, and a block design hands the drift entirely to one side of the ratio.
 * Interleaving gives both sizes an equal draw from every load regime, so the two minimums are comparable.
 */
function bestOfBoth(smallReps: number, largeReps: number): { small: number; large: number } {
	const smallInput = UNIT.repeat(smallReps)
	const largeInput = UNIT.repeat(largeReps)

	// Warm first — a cold JIT on the smaller sample would inflate the ratio and fail spuriously.
	computeQueryShape(smallInput)
	computeQueryShape(largeInput)

	let small = Number.POSITIVE_INFINITY
	let large = Number.POSITIVE_INFINITY

	for (let i = 0; i < TIMING_SAMPLES; i++) {
		small = Math.min(small, timeAt(smallInput))
		large = Math.min(large, timeAt(largeInput))
	}

	return { small, large }
}

test("computeQueryShape stays linear as segment count doubles", () => {
	// Large enough that fixed overheads do not dominate the ratio.
	const { small, large } = bestOfBoth(4000, 8000)
	const ratio = large / Math.max(small, 0.001)

	// 3.5, not 3: the 3x bar produced two false failures on loaded CI runners on 2026-08-05 (measured
	// 3.13x, 15.3ms -> 48.0ms, best-of-three block design). Quadratic doubles to ~4x at these sizes —
	// fixed overhead is <1ms against 15ms+ samples — so 3.5 still separates the real failure from a
	// noisy neighbour.
	expect(
		ratio,
		`doubling the input multiplied the cost by ${ratio.toFixed(2)}x (${small.toFixed(1)}ms -> ${large.toFixed(1)}ms). ` +
			`Linear is ~2x; quadratic is ~4x. Something in the query-shape stage is scanning pairs again — see ` +
			`region-abbreviations.ts for the two-pointer merge this replaced.`
	).toBeLessThan(3.5)
})
