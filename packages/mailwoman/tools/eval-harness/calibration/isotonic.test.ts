/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two digests below are the SHA-256 of the table and the report the Python fitter
 *   (the deleted Python `calibration.isotonic`, NumPy 2.5.3, CPython 3.12.3) wrote for
 *   `data/eval/calibration/confidences-v413.jsonl` at seed 20260607 and model version 4.13.0, at revision `ae90ae7a2`.
 *   A digest rather than a copy is pinned, because a formatter rewrites a committed JSON copy's whitespace.
 */

import { sha256Hex } from "@mailwoman/core/hash"
import { repoRootPath } from "@mailwoman/core/paths"
import { pythonJSONDumps } from "@mailwoman/core/strings/python-json"
import { JSONSpliterator } from "spliterator"
import { describe, expect, test } from "vitest"

import {
	buildPayload,
	fitAndMeasure,
	pava,
	recordedPermutation,
	renderCalibrationReport,
	type SpanConfidence,
} from "./isotonic.ts"
import { numpyInterp, numpyLinspace, pairwiseSum } from "./numpy.ts"

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

	expect(sha256Hex(pythonJSONDumps(buildPayload(options, fit), { indent: 2 }) + "\n")).toBe(
		"ba2245402f98576ffcf275fcfc700645e3f9c87d533c35df11d10044d6286bcd"
	)

	expect(sha256Hex(renderCalibrationReport(options, fit))).toBe(
		"2a0d275f5791d835ff1f7685bdbdd2b689e5998502fd19fae2ad4b244694216c"
	)
})
