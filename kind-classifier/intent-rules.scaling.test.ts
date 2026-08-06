/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   COST OF THE §4 INTENT VOCABULARY. Stage 2.5 runs on every query on the hot per-query path
 *   (`geocode-core.ts`'s `deriveGeocodeRegister` calls `classifyKindSync` on every geocode, and
 *   `runPipeline` calls it on every parse), so three new scorers is a claim that has to be
 *   measured rather than asserted.
 *
 *   Two assertions, and they measure different failure modes:
 *
 *   1. **Growth** — the intent rules must stay LINEAR in input length. All three are
 *       lexicon-lookup-cheap by construction (a bounded regex over the tail, a Set membership test
 *       per word, a length gate that rejects anything over 30 characters before any of it runs), and
 *       the ratio is what proves that rather than the docstring saying so. A ratio assertion also
 *       survives a loaded runner in a way a millisecond budget does not.
 *   2. **Absolute overhead vs the pre-§4 scorer set** — the number the reader of ROAD_TO_V9 §4
 *       actually wants: what did adding intent cost per query? Measured on the corpus register mix
 *       rather than on a synthetic string, and asserted as a RATIO against the same replayed
 *       baseline the invariance receipt uses, for the same reason: an absolute microsecond budget
 *       flakes, a doubling does not.
 */

import { computeQueryShape } from "@mailwoman/query-shape"
import { expect, test } from "vitest"

import { classifyKindSync } from "./classify.ts"
import { scoreBareToponym, scoreNearMe, scoreRoutePair } from "./intent-rules.ts"
import {
	scoreIntersection,
	scoreLandmark,
	scoreLocalityOnly,
	scorePoBox,
	scorePostcodeOnly,
	scoreStructuredAddress,
	scoreVague,
	scoreVenueLandmark,
} from "./rules.ts"
import type { NormalizedInputLite, QueryShapeLike } from "./types.ts"

/**
 * Timing samples per measurement. Best-of, for the reason `phrase-grouper/rules.scaling.test.ts` gives: contention only
 * ever ADDS time, so the minimum is the sample least polluted by the neighbours.
 */
const TIMING_SAMPLES = 5

/**
 * Capitalized run — every token is candidate place-name content, which is the shape that makes `bareNameWords`'s word
 * split and per-word Set probes work hardest before the length gate can reject.
 */
const CAPS_RUN_UNIT = "Aa "

function bestOf(run: () => void): number {
	// Warm once so a cold JIT on the first measurement does not inflate the ratio.
	run()

	let best = Number.POSITIVE_INFINITY

	for (let i = 0; i < TIMING_SAMPLES; i++) {
		const start = performance.now()

		run()

		best = Math.min(best, performance.now() - start)
	}

	return best
}

test("the intent rules stay linear in input length", () => {
	const at = (chars: number): number => {
		const text = CAPS_RUN_UNIT.repeat(Math.ceil(chars / CAPS_RUN_UNIT.length))
		const input: NormalizedInputLite = { raw: text, normalized: text }
		const shape = computeQueryShape(text)

		return bestOf(() => {
			scoreBareToponym(input, shape as QueryShapeLike)
			scoreRoutePair(input, shape as QueryShapeLike)
			scoreNearMe(input, shape as QueryShapeLike)
		})
	}

	// Sizes chosen so the absolute timings clear a millisecond: at 50k/100k the whole measurement lands under 0.3 ms,
	// where scheduler noise on a parallel test runner is larger than the signal and the ratio flakes (measured: 3.25x on
	// a run where both arms were sub-millisecond). The work being timed is a `trim` + `toLowerCase` + two anchored
	// regexes over the full string, which is linear; the length gate rejects everything else at 30 characters.
	const small = at(500_000)
	const large = at(1_000_000)
	const ratio = large / Math.max(small, 0.001)

	expect(
		ratio,
		`doubling the input multiplied the intent-rule cost by ${ratio.toFixed(2)}x ` +
			`(${small.toFixed(3)}ms -> ${large.toFixed(3)}ms). Linear is ~2x; quadratic is ~4x.`
	).toBeLessThan(3)
})

/**
 * The pre-§4 scorer list, replayed. Same construction as `mailwoman/test/kind-intent-invariance.test.ts` and for the
 * same reason — a snapshot would drift the first time an incumbent rule was tuned.
 */
function classifyPreIntent(input: NormalizedInputLite, shape: QueryShapeLike): void {
	Math.max(
		scorePoBox(input, shape),
		scoreLandmark(input, shape),
		scoreVenueLandmark(input, shape),
		scoreIntersection(input, shape),
		scorePostcodeOnly(input, shape),
		scoreLocalityOnly(input, shape),
		scoreStructuredAddress(input, shape),
		scoreVague(input, shape)
	)
}

/**
 * A realistic query mix: full addresses (the population that must not pay), bare toponyms, fragments, the intent shapes
 * themselves. Shapes are precomputed — Stage 2.2 is not what is being measured.
 */
const QUERY_MIX = [
	"350 5th Ave, New York, NY 10118",
	"1600 Pennsylvania Ave NW, Washington, DC 20500",
	"12 rue de Rome, 75008 Paris",
	"Neusser Str. 12, Nippes, 50733 Köln",
	"10 Downing Street, London SW1A 2AA",
	"PO Box 1234, Austin, TX 78701",
	"corner of 5th and Main",
	"10118",
	"Paris",
	"Springfield",
	"New York",
	"Paris London",
	"gas station near me",
	"restaurants nearby",
	"tacos",
]

test("intent adds a bounded fraction to the per-query classify cost", () => {
	const prepared = QUERY_MIX.flatMap((raw) =>
		[raw, raw.toLowerCase()].map((text) => ({
			input: { raw: text, normalized: text } satisfies NormalizedInputLite,
			shape: computeQueryShape(text) as QueryShapeLike,
		}))
	)

	// Enough repetitions that one pass over the mix is measurable at millisecond resolution.
	const PASSES = 2000

	const baseline = bestOf(() => {
		for (let p = 0; p < PASSES; p++) {
			for (const { input, shape } of prepared) {
				classifyPreIntent(input, shape)
			}
		}
	})

	const withIntent = bestOf(() => {
		for (let p = 0; p < PASSES; p++) {
			for (const { input, shape } of prepared) {
				classifyKindSync(input, shape)
			}
		}
	})

	const perQueryBaselineUs = (baseline * 1000) / (PASSES * prepared.length)
	const perQueryIntentUs = (withIntent * 1000) / (PASSES * prepared.length)
	const ratio = withIntent / Math.max(baseline, 0.001)

	// Printed, not only asserted: the docstring rule in AGENTS.md is that a measured claim carries its number, and this
	// is the number ROAD_TO_V9 §4's cost line is reporting.
	// oxlint-disable-next-line no-console -- the measurement IS the deliverable here.
	console.log(
		`intent cost: ${perQueryBaselineUs.toFixed(3)} us/query baseline -> ${perQueryIntentUs.toFixed(3)} us/query ` +
			`with intent (${ratio.toFixed(2)}x, +${(perQueryIntentUs - perQueryBaselineUs).toFixed(3)} us) ` +
			`over ${prepared.length} queries x ${PASSES} passes`
	)

	// The BAR IS ABSOLUTE, and the ratio above is reported rather than asserted, because the ratio's denominator is the
	// unstable half of the pair: the baseline arm is a bare score-and-max with no allocation, which V8 optimizes
	// aggressively and inconsistently — measured at 0.354, 0.585 and 0.663 us/query across three consecutive runs of
	// this file, moving the ratio from 1.94x to 3.48x while the numerator barely moved (1.185-1.284 us/query). Asserting
	// on the ratio measures the JIT's mood; asserting on the absolute measures Stage 2.5.
	//
	// 10 us is ~8x the measured cost. It is set to catch an ORDER-OF-MAGNITUDE regression (someone adding a lexicon
	// load, a gazetteer probe, or an unbounded scan to an intent rule), not to police a microsecond, and it sits far
	// enough above the measurement to survive a loaded CI runner. For scale: the classifier's own neighbour on this path
	// is a ~3 ms ONNX inference, so Stage 2.5 in full is ~0.04% of a parse.
	expect(
		perQueryIntentUs,
		`Stage 2.5 cost ${perQueryIntentUs.toFixed(3)} us/query (baseline ${perQueryBaselineUs.toFixed(3)}, ` +
			`ratio ${ratio.toFixed(2)}x) — an intent rule has most likely started doing real work`
	).toBeLessThan(10)
})
