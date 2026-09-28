/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Measures the cost of the §4 intent vocabulary. Stage 2.5 runs on every query. `deriveGeocodeRegister` in
 *   `geocode-core.ts` calls `classifyKindSync` on every geocode. `runPipeline` calls it on every parse. The cost
 *   of three new scorers therefore needs measurement.
 *
 *   The test makes two assertions. They measure different failure modes:
 *
 *   1. **Growth** — the intent rules must stay linear in input length. All three are
 *       lexicon-lookup-cheap by construction (a bounded regex over the tail, a Set membership test
 *       per word, a length check that rejects anything over 30 characters before any of it runs), and
 *       the ratio is what proves that rather than the docstring saying so. A ratio assertion also
 *       survives a loaded runner in a way a millisecond budget does not.
 *   2. **Absolute overhead vs the pre-§4 scorer set** — the number the reader of ROAD_TO_V9 §4
 *       measures the cost of adding intent per query. The test uses the corpus register mix instead of a synthetic
 *       string. It asserts a ratio against the same replayed baseline as the invariance receipt. An absolute
 *       microsecond budget can flake. A doubling does not.
 */

import { classifyKindSync } from "@mailwoman/kind-classifier/classify"
import { scoreBareToponym, scoreNearMe, scoreRoutePair } from "@mailwoman/kind-classifier/intent-rules"
import {
	scoreIntersection,
	scoreLandmark,
	scoreLocalityOnly,
	scorePoBox,
	scorePostcodeOnly,
	scoreStructuredAddress,
	scoreVague,
	scoreVenueLandmark,
} from "@mailwoman/kind-classifier/rules"
import {
	computeQueryShape,
	type NormalizedInputLite,
	type QueryShapeSegmentsView as QueryShapeLike,
} from "@mailwoman/query-shape"
import { expect, test } from "vitest"

/**
 * The test records timing samples for each measurement.
 *
 * Best-of, for the reason `phrase-grouper/rules.scaling.test.ts` gives: contention only
 * ever adds time, so the minimum is the sample least polluted by the neighbours.
 */
const TIMING_SAMPLES = 5

/**
 * The capitalized run makes every token candidate place-name content.
 *
 * This input makes `bareNameWords`'s word split and per-word Set probes do the most work
 * before the length check rejects it.
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

/**
 * Median of per-pair ratios, with the two arms measured back-TO-back inside each pair.
 *
 * The test exposes the ratio to a load burst between blocks if it measures all small trials
 * and then all large trials (even as best-of-N).
 * The test host also runs the CI fleet, so that condition occurs.
 *
 * It triggered the 3x bar three times in one night at 3.19–3.25x while both
 * arms remained individually healthy.
 * Each pair exposes both arms to the same burst.
 * The median removes corrupted pairs in either direction.
 *
 * A genuinely quadratic run still shows ~4x in every clean pair.
 */
function medianPairedRatio(small: () => void, large: () => void): { ratio: number; smallMs: number; largeMs: number } {
	small()
	large()

	const ratios: number[] = []
	let bestSmall = Number.POSITIVE_INFINITY
	let bestLarge = Number.POSITIVE_INFINITY

	for (let i = 0; i < TIMING_SAMPLES; i++) {
		const s0 = performance.now()

		small()
		const s = performance.now() - s0

		const l0 = performance.now()

		large()
		const l = performance.now() - l0

		ratios.push(l / Math.max(s, 0.001))
		bestSmall = Math.min(bestSmall, s)
		bestLarge = Math.min(bestLarge, l)
	}

	ratios.sort((a, b) => a - b)

	return { ratio: ratios[Math.floor(ratios.length / 2)]!, smallMs: bestSmall, largeMs: bestLarge }
}

test("the intent rules stay linear in input length", () => {
	const runAt = (chars: number): (() => void) => {
		const text = CAPS_RUN_UNIT.repeat(Math.ceil(chars / CAPS_RUN_UNIT.length))
		const input: NormalizedInputLite = { raw: text, normalized: text }
		const shape = computeQueryShape(text)

		return () => {
			scoreBareToponym(input, shape as QueryShapeLike)
			scoreRoutePair(input, shape as QueryShapeLike)
			scoreNearMe(input, shape as QueryShapeLike)
		}
	}

	// Sizes chosen so the absolute timings clear a millisecond: at 50k/100k the whole measurement
	// lands under 0.3 ms, where scheduler noise on a parallel test runner is larger than the signal
	// and the ratio flakes (measured: 3.25x on a run where both arms were sub-millisecond).
	// The work being timed is a `trim` + `toLowerCase` + two anchored regexes The
	// work grows linearly with the full string length.
	// The length check rejects everything else at 30 characters.
	const { ratio, smallMs, largeMs } = medianPairedRatio(runAt(500_000), runAt(1_000_000))

	expect(
		ratio,
		`doubling the input multiplied the intent-rule cost by ${ratio.toFixed(2)}x ` +
			`(best ${smallMs.toFixed(3)}ms -> ${largeMs.toFixed(3)}ms). Linear is ~2x; quadratic is ~4x.`
	).toBeLessThan(3)
})

/**
 * The pre-§4 scorer list, replayed.
 *
 * Same construction as `mailwoman/test/kind-intent-invariance.test.ts` and for the same reason.
 * A snapshot would drift the first time an incumbent rule was tuned.
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
 * A realistic query mix: full addresses (the population that must not pay),
 * bare toponyms, fragments, the intent shapes themselves.
 *
 * Shapes are precomputed — Stage 2.2 is not what is being measured.
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

	// Print the result as well as asserting it. The agents.md docstring rule requires a measured value to include its
	// number. This is the value ROAD_TO_V9 §4's cost line reports.
	// oxlint-disable-next-line no-console -- the measurement is the deliverable here.
	console.log(
		`intent cost: ${perQueryBaselineUs.toFixed(3)} us/query baseline -> ${perQueryIntentUs.toFixed(3)} us/query ` +
			`with intent (${ratio.toFixed(2)}x, +${(perQueryIntentUs - perQueryBaselineUs).toFixed(3)} us) ` +
			`over ${prepared.length} queries x ${PASSES} passes`
	)

	// The bar uses an absolute cost.
	// The test reports the ratio without asserting it because its denominator
	// is the unstable half of the pair.
	// The baseline arm performs score-and-max without allocation.
	// V8 optimizes it inconsistently.
	// Three consecutive runs measured 0.354, 0.585 and 0.663 us/query.
	// The ratio moved from 1.94x to 3.48x while the numerator stayed within 1.185–1.284 us/query.
	// The ratio mostly measures the JIT's schedule.
	// The absolute value measures Stage 2.5.
	//
	// 10 us is ~8x the measured cost.
	// The 10 us bar catches an order-of-magnitude regression, such as a lexicon load,
	// a gazetteer probe or an unbounded scan in an intent rule.
	// It does not police microseconds and leaves room for a loaded CI runner.
	// For scale: the classifier's own neighbour on this path is a ~3 ms ONNX inference,
	// so Stage 2.5 in full is ~0.04% of a parse.
	expect(
		perQueryIntentUs,
		`Stage 2.5 cost ${perQueryIntentUs.toFixed(3)} us/query (baseline ${perQueryBaselineUs.toFixed(3)}, ` +
			`ratio ${ratio.toFixed(2)}x) — an intent rule has most likely started doing real work`
	).toBeLessThan(10)
})
