/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The report digest is the SHA-256 of the report the Python fitter (the deleted Python `calibration.isotonic`,
 *   NumPy 2.5.3, CPython 3.12.3) wrote for `data/eval/calibration/confidences-v413.jsonl` at seed 20260607 and model
 *   version 4.13.0, at revision `ae90ae7a2`. The table digest was that fitter's until the table moved to the
 *   repository's JSON spelling (#2879 T62). At the parent revision this port reproduced the Python table byte for byte,
 *   and the digest was then re-frozen from the same values in the new spelling.
 *   A digest rather than a copy is pinned, because a formatter rewrites a committed JSON copy's whitespace.
 */

import { sha256Hex } from "@mailwoman/core/hash"
import { orderedJSON } from "@mailwoman/core/json"
import { repoRootPath } from "@mailwoman/core/paths"
import { JSONSpliterator } from "spliterator"
import { describe, expect, test } from "vitest"

import {
	buildPayload,
	fitAndMeasure,
	pava,
	recordedPermutation,
	renderCalibrationReport,
	ROBUST_MCE_MIN_SAMPLES,
	robustMCE,
	type SpanConfidence,
} from "./isotonic.ts"
import { numpyInterp, numpyLinspace, pairwiseSum } from "./numpy.ts"

describe("robustMCE", () => {
	test("counts a full bin whose mean confidence is exactly 0, and skips an empty one", () => {
		const n = ROBUST_MCE_MIN_SAMPLES

		expect(
			robustMCE([
				{ lo: 0, hi: 0.1, n, conf: 0, acc: 0.4 },
				{ lo: 0.9, hi: 1, n, conf: 0.95, acc: 0.9 },
				{ lo: 0.5, hi: 0.6, n: 0, conf: null, acc: null },
			])
		).toBeCloseTo(0.4, 12)
	})
})

describe("the NumPy operations", () => {
	test("the pairwise sum adds in NumPy's order, which differs from a running sum", () => {
		const values = Array.from({ length: 1000 }, (_, i) => 0.1 * (i % 7) + 1e-9 * i)
		let running = 0

		for (const v of values) {
			running += v
		}

		expect(pairwiseSum(values)).not.toBe(running)
		expect(pairwiseSum(values)).toBeCloseTo(running, 9)
	})

	test("interp clamps outside the range and reads the last of equal x values on a match", () => {
		expect(numpyInterp(-1, [0, 1], [2, 3])).toBe(2)
		expect(numpyInterp(5, [0, 1], [2, 3])).toBe(3)
		expect(numpyInterp(0.5, [0, 0.5, 0.5, 1], [0, 0.2, 0.4, 1])).toBe(0.4)
		expect(numpyInterp(0.25, [0, 1], [0, 1])).toBe(0.25)
	})

	test("linspace ends on its stop", () => {
		expect(numpyLinspace(0, 1, 21).at(-1)).toBe(1)
	})
})

test("too few records for an evaluation split are refused, and a source with none reports no ECE", () => {
	const record = (conf: number, source: string): SpanConfidence => ({
		conf,
		correct: conf > 0.5,
		source,
		tag: "street",
		country: "US",
	})

	const four = [0.2, 0.4, 0.6, 0.8].map((conf) => record(conf, "corpus"))

	expect(() => fitAndMeasure(four, { bins: 10, eceBins: 10, permutation: [0, 1, 2, 3] })).toThrow(
		"4 records give an empty evaluation split"
	)

	const ten = Array.from({ length: 10 }, (_, i) => record(i / 10, "corpus"))
	const fit = fitAndMeasure(ten, { bins: 10, eceBins: 10, permutation: ten.map((_, i) => i) })

	expect(fit.metrics.ece_raw_oa_eval).toBeNull()
	expect(fit.metrics.ece_cal_oa_eval).toBeNull()
	expect(fit.metrics.ece_raw_corpus_eval).not.toBeNull()
})

test("PAVA pools a decreasing run into its weighted mean", () => {
	expect(pava([1, 0, 0, 1], [1, 1, 1, 1])).toEqual([1 / 3, 1 / 3, 1 / 3, 1])
})

test("the fit reproduces the Python fitter's table and report on the committed v4.13.0 confidences", async () => {
	const conf = repoRootPath("data/eval/calibration/confidences-v413.jsonl")
	const records = await Array.fromAsync(JSONSpliterator.fromAsync<SpanConfidence>(conf))
	const permutation = await recordedPermutation(20_260_607, records.length)

	expect(permutation).not.toBeNull()

	const options = {
		model: "neural-weights-en-us",
		modelVersion: "4.13.0",
		createdFrom: "data/eval/calibration/confidences-v413.jsonl",
		bins: 20,
		eceBins: 15,
	}

	const fit = fitAndMeasure(records, { bins: 20, eceBins: 15, permutation: permutation! })

	expect(sha256Hex(orderedJSON(buildPayload(options, fit), { indent: "\t" }) + "\n")).toBe(
		"4954f8d59b6b02d262840d5474327bc11e47b0941aff370794929bb440da6cb4"
	)

	expect(sha256Hex(renderCalibrationReport(options, fit))).toBe(
		"bd789dc2e935aa9a1ccc89e85bbda4ed406bd5ae6922faaf9f9f8b2d170bba09"
	)
})
