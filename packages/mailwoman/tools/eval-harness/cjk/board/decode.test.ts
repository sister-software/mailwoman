/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { boardArcKm, decodeAllSpans, decodeRuns, normalizeCentroidKey } from "#tools/eval-harness/cjk/board/decode"

const LABELS = ["O", "B-unit", "I-unit", "B-municipality", "I-municipality"]

describe("the CJK board decoder", () => {
	it("splits runs at a B label and at a change of tag, in code points", () => {
		// 𠮷 is outside the Basic Multilingual Plane, so a UTF-16 offset would differ from the code-point offset.
		expect(decodeRuns("𠮷野市1", [3, 4, 4, 1], LABELS)).toEqual(
			new Map([
				["municipality", [[0, 3]]],
				["unit", [[3, 4]]],
			])
		)

		expect(decodeRuns("ab", [3, 3], LABELS)).toEqual(
			new Map([
				[
					"municipality",
					[
						[0, 1],
						[1, 2],
					],
				],
			])
		)

		expect(decodeRuns("ab", [-100, 3], LABELS)).toEqual(new Map([["municipality", [[1, 2]]]]))
	})

	it("adds the surface of same-tag runs that only whitespace separates", () => {
		const raw = "1층 141호"
		const ids = [1, 2, 0, 1, 2, 2, 2]

		expect(decodeAllSpans(raw, ids, LABELS).get("unit")).toEqual(["1층", "141호", "1층 141호"])
	})

	it("refuses a label id outside the head", () => {
		expect(() => decodeRuns("a", [9], LABELS)).toThrow(/outside the 5-label head/)
	})

	it("keys the centroid table without whitespace, ideographic spaces included", () => {
		expect(normalizeCentroidKey("東京都 |　千代田区")).toBe("東京都|千代田区")
	})

	it("measures at the board's registered radius", () => {
		expect(boardArcKm(0, 0, 0, 1)).toBeCloseTo((6371.0088 * Math.PI) / 180, 9)
	})
})
