/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The reliability math, on samples whose answer is arithmetic rather than a model's.
 *
 *   A calibration curve is the one measurement that is worthless when it is subtly wrong: an ECE computed against the
 *   wrong denominator, or a table that drops its empty bins, still reads as a plausible number and still gets quoted
 *   into a threshold decision. So the binning, the weighting and the eval table are pinned here against samples
 *   constructed to have a known answer.
 */

import { errorClasses, reliabilityCurve, thresholdTable, type Observation } from "@mailwoman/dev-mcp/reliability"
import { describe, expect, it } from "vitest"

/**
 * `n` observations at one confidence, of which `correct` are right. Strata are irrelevant to the math and left empty.
 */
function at(confidence: number, n: number, correct: number): Observation[] {
	return Array.from({ length: n }, (_, index) => ({ confidence, correct: index < correct, strata: {} }))
}

describe("reliabilityCurve", () => {
	it("reports a perfectly calibrated sample as ECE 0", () => {
		// 0.95-confident and right 95% of the time; 0.25-confident and right 25% of the time.
		const curve = reliabilityCurve([...at(0.95, 100, 95), ...at(0.25, 100, 25)], 10)

		expect(curve.ece).toBeCloseTo(0, 10)
		expect(curve.mce).toBeCloseTo(0, 10)
		expect(curve.n).toBe(200)
		expect(curve.accuracy).toBeCloseTo(0.6, 10)
	})

	it("signs the gap so overconfidence is negative", () => {
		// The direction is the finding, not the magnitude: a confidence ABOVE the accuracy it earns is the failure that
		// lets a caller trust a wrong answer, and an unsigned gap cannot tell it from the harmless direction.
		const overconfident = reliabilityCurve(at(0.9, 100, 50), 10)
		const underconfident = reliabilityCurve(at(0.5, 100, 90), 10)

		expect(overconfident.bins.find((bin) => bin.n > 0)?.gap).toBeCloseTo(-0.4, 10)
		expect(underconfident.bins.find((bin) => bin.n > 0)?.gap).toBeCloseTo(0.4, 10)
	})

	it("weights ECE by bin population and takes MCE as the worst single bin", () => {
		// 90 observations off by 0.1 and 10 off by 0.55. The two diverge on purpose: a rare, badly calibrated bin barely
		// moves ECE and dominates MCE, so quoting one where the other was meant reverses the reading.
		const curve = reliabilityCurve([...at(0.9, 90, 72), ...at(0.55, 10, 0)], 10)

		expect(curve.ece).toBeCloseTo(0.9 * 0.1 + 0.1 * 0.55, 10)
		expect(curve.mce).toBeCloseTo(0.55, 10)
	})

	it("KEEPS empty bins", () => {
		// A model whose confidences never enter the low bins is itself the finding. Dropping the empty rows turns "this
		// model is never unsure" into a table that simply starts at 0.8, which reads as a narrower measurement rather
		// than a wider result.
		const curve = reliabilityCurve(at(0.95, 10, 9), 10)

		expect(curve.bins).toHaveLength(10)
		expect(curve.bins.filter((bin) => bin.n === 0)).toHaveLength(9)
		expect(curve.bins.at(-1)?.n).toBe(10)
	})

	it("puts confidence 1.0 in the top bin rather than off the end", () => {
		const curve = reliabilityCurve(at(1, 5, 5), 10)

		expect(curve.bins.at(-1)?.n).toBe(5)
	})

	it("reports an empty sample as empty rather than as zero error", () => {
		// ECE 0 on no observations and ECE 0 on a perfect model are the same number and opposite facts.
		const curve = reliabilityCurve([], 10)

		expect(curve.n).toBe(0)
		expect(curve.accuracy).toBeNull()
		expect(curve.ece).toBeNull()
	})
})

describe("thresholdTable", () => {
	const sample = [...at(0.95, 80, 76), ...at(0.85, 20, 10), ...at(0.4, 100, 20)]

	it("counts what a check admits and what it forgoes", () => {
		const [row] = thresholdTable(sample, [0.9])

		expect(row?.admitted).toBe(80)
		expect(row?.precision_above).toBeCloseTo(76 / 80, 10)
		expect(row?.errors_admitted).toBe(4)
		// 76 + 10 + 20 = 106 correct overall, 76 of them above the eval.
		expect(row?.correct_below).toBe(30)
	})

	it("reports precision above an empty check as null, not as zero", () => {
		const [row] = thresholdTable(sample, [0.999])

		expect(row?.admitted).toBe(0)
		expect(row?.precision_above).toBeNull()
	})
})

describe("errorClasses", () => {
	it("ranks the confusions a check lets through", () => {
		const observations: Observation[] = [
			{ confidence: 0.95, correct: false, strata: { expected: "ES", predicted: "PT" } },
			{ confidence: 0.95, correct: false, strata: { expected: "ES", predicted: "PT" } },
			{ confidence: 0.95, correct: false, strata: { expected: "AT", predicted: "DE" } },
			// Below the eval: a real error, but not one this check admits.
			{ confidence: 0.2, correct: false, strata: { expected: "SI", predicted: "HR" } },
			{ confidence: 0.99, correct: true, strata: { expected: "FR", predicted: "FR" } },
		]

		const classes = errorClasses(observations, 0.9, 10)

		expect(classes[0]).toEqual({ expected: "ES", predicted: "PT", n: 2 })
		expect(classes.map((entry) => entry.expected)).not.toContain("SI")
	})
})
