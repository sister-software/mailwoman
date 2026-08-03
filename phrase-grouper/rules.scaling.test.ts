/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `groupPhrasesSync` must stay LINEAR in segment length, including on the input shape that makes it work
 *   hardest: a long run of capitalized tokens, every one of which is candidate place-name content.
 *
 *   `scoreLocalityPhrase` walks forward from each start index to measure the run it could propose. That walk
 *   has to stay bounded by {@link MAX_LOCALITY_PHRASE_TOKENS}, because the proposals it feeds are clamped to
 *   that length anyway — unbounded, every start index walks to the end of the run and the segment costs
 *   quadratic time for an identical result.
 *
 *   Correctness tests cannot catch that: bounded and unbounded walks emit the same proposals, which is what
 *   makes the waste invisible. Only the growth curve separates them, so the assertion is on the ratio rather
 *   than on absolute milliseconds — a millisecond budget would flake on a loaded runner while a complexity
 *   regression is exactly what changes the ratio.
 */

import { normalize } from "@mailwoman/normalize"
import { groupPhrasesSync } from "@mailwoman/phrase-grouper"
import { computeQueryShape } from "@mailwoman/query-shape"
import { expect, test } from "vitest"

/**
 * Every token is capitalized place-name content and nothing terminates the run — the worst case for a forward walk, and
 * the shape a pasted document produces.
 */
const CAPS_RUN_UNIT = "Aa "

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
function timeAt(chars: number): number {
	const input = CAPS_RUN_UNIT.repeat(Math.ceil(chars / CAPS_RUN_UNIT.length))
	const normalized = normalize(input)
	const shape = computeQueryShape(normalized)

	// Warm once so a cold JIT on the smaller sample does not inflate the ratio.
	groupPhrasesSync(normalized as never, shape as never, { tag: "en-US" } as never)

	const start = performance.now()

	groupPhrasesSync(normalized as never, shape as never, { tag: "en-US" } as never)

	return performance.now() - start
}

function bestOf(chars: number): number {
	let best = Number.POSITIVE_INFINITY

	for (let i = 0; i < TIMING_SAMPLES; i++) {
		best = Math.min(best, timeAt(chars))
	}

	return best
}

test("groupPhrasesSync stays linear on a long capitalized run", () => {
	const small = bestOf(10_000)
	const large = bestOf(20_000)
	const ratio = large / Math.max(small, 0.001)

	expect(
		ratio,
		`doubling the input multiplied the cost by ${ratio.toFixed(2)}x (${small.toFixed(1)}ms -> ${large.toFixed(1)}ms). ` +
			`Linear is ~2x; quadratic is ~4x. A forward walk in phrase-grouper/rules.ts has most likely stopped ` +
			`respecting MAX_LOCALITY_PHRASE_TOKENS.`
	).toBeLessThan(3)
})
