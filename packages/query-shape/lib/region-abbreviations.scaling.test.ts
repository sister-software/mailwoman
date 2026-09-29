/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `computeQueryShape` must stay linear in input size.
 *
 *   Every parse runs this stage before the model. Its token and segment counts both grow with input length.
 *   A routine that pairs them is quadratic. A 1 MB query then takes minutes rather than milliseconds.
 *   `region-abbreviations.ts` must walk both inputs.
 *
 *   Correctness tests cannot distinguish quadratic and linear implementations because both return the same results.
 *   The growth curve distinguishes them, so this test compares elapsed-time ratios instead of a millisecond budget.
 *   Absolute timing would make the test unstable on CI. An input twice as large gives quadratic code about 4x the work
 *   and linear code about 2x. The 3x threshold tolerates a loaded runner and catches the quadratic behavior.
 */

import { expect, test } from "vitest"

import { computeQueryShape } from "#index"

/**
 * One "City, ST ZIP" record.
 *
 * Each repetition grows segments and tokens together.
 * That pairing made the original algorithm quadratic.
 */
const UNIT = "123 Main St, Springfield, IL 62701, "

/**
 * Each size has timing samples.
 *
 * Five keeps the minimum honest against back-to-back load spikes
 * (three let one through on 2026-08-05 — see the threshold note below) without making the test slow.
 */
const TIMING_SAMPLES = 5

/**
 * Contention can only ever ADD time to a sample, never remove it, so the minimum is
 * the run least polluted by whatever else the machine was doing.
 *
 * A mean or a single sample includes load spikes.
 * On a shared CI runner, that measures neighboring work along with the algorithm.
 */
function timeAt(input: string): number {
	const start = performance.now()

	computeQueryShape(input)

	return performance.now() - start
}

/**
 * Sample both sizes interleaved (small, large, small, large, …) rather than
 * all-small-then-all-large: runner load and thermal state drift during the test.
 *
 * A block design would apply that drift to only one side of the ratio.
 *
 * An interleaved order gives both sizes an equal draw from every load regime,
 * so the two minimums are comparable.
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

	// 3.5 rather than 3: the 3x bar produced two false failures on loaded CI runners on
	// 2026-08-05 (measured 3.13x, 15.3ms -> 48.0ms, best-of-three block design).
	// Quadratic doubles to ~4x at these sizes — fixed overhead is <1ms against 15ms+ samples —
	// so 3.5 still separates the real failure from a noisy neighbour.
	expect(
		ratio,
		`doubling the input multiplied the cost by ${ratio.toFixed(2)}x (${small.toFixed(1)}ms -> ${large.toFixed(1)}ms). ` +
			`Linear is ~2x; quadratic is ~4x. Something in the query-shape stage is scanning pairs again — see ` +
			`region-abbreviations.ts for the two-pointer merge this replaced.`
	).toBeLessThan(3.5)
})
