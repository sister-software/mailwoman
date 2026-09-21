/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The abstention-threshold curve (#2264) re-grades frozen results rather than re-running a resolver, so the
 *   two properties worth pinning are that it converts a withheld selection into an abstention rather than a
 *   wrong answer, and that it leaves an errored row alone. A harness failure is not a selection, and folding
 *   one into abstention is the confusion the benchmark's strata exist to measure.
 *
 *   The curve at threshold 0 must equal the unthresholded metrics exactly. That is what says the sweep and the
 *   benchmark's own tables count through one function rather than two that agree today.
 */

import type { ArmRowResult } from "mailwoman/eval-harness/same-data/arms"
import type { SameDataPanelRow } from "mailwoman/eval-harness/same-data/fixture"
import { armMetrics } from "mailwoman/eval-harness/same-data/score"
import {
	applyThreshold,
	dominatingPoints,
	irreducibleFalseSelections,
	thresholdCurve,
} from "mailwoman/eval-harness/same-data/threshold"
import { describe, expect, it } from "vitest"

function panelFor(id: string, goldPresent: boolean): SameDataPanelRow {
	return {
		id,
		stratum: goldPresent ? "unambiguous" : "gold_absent",
		query: "Springfield",
		goldPresent,
		gold: {
			geonameid: "4250542",
			placeIDs: goldPresent ? [101] : [],
			name: "Springfield",
			country: "US",
			admin1: "IL",
			lat: 39.8017,
			lon: -89.6437,
			population: 114_394,
		},
		source: { register: "geonames:cities15000", license: "CC-BY-4.0", attribution: "GeoNames" },
	}
}

function resultFor(overrides: Partial<ArmRowResult> & Pick<ArmRowResult, "rowID">): ArmRowResult {
	return {
		arm: "mailwoman",
		stratum: "unambiguous",
		selection: "101",
		correct: true,
		wrongArea: false,
		distanceKm: 0,
		confidence: 0.5,
		mechanism: "picked:ranked",
		evidence: {
			arm: "mailwoman",
			rowID: overrides.rowID,
			rowDigest: "digest",
			poolSize: 1,
			candidateIDs: ["101"],
			candidateFields: ["id"],
		},
		...overrides,
	}
}

const PANEL = new Map([
	["present", panelFor("present", true)],
	["absent", panelFor("absent", false)],
])

describe("same-data abstention threshold (#2264)", () => {
	it("turns a below-threshold selection into an abstention rather than a wrong answer", () => {
		const [withheld] = applyThreshold([resultFor({ rowID: "present", confidence: 0.2 })], 0.5)

		expect(withheld?.selection).toBeNull()
		expect(withheld?.correct).toBe(false)
		expect(withheld?.wrongArea).toBeNull()
		expect(withheld?.distanceKm).toBeNull()
		expect(withheld?.mechanism).toBe("withheld:below_threshold picked:ranked")
	})

	it("keeps a selection whose confidence reaches the threshold exactly", () => {
		const [kept] = applyThreshold([resultFor({ rowID: "present", confidence: 0.5 })], 0.5)

		expect(kept?.selection).toBe("101")
		expect(kept?.correct).toBe(true)
	})

	it("leaves an errored row untouched, because a harness failure is not a selection", () => {
		const errored = resultFor({
			rowID: "present",
			confidence: 0,
			selection: null,
			correct: false,
			error: "replay miss",
		})

		const [passed] = applyThreshold([errored], 1)

		expect(passed).toStrictEqual(errored)
	})

	it("reproduces the unthresholded metrics at threshold zero", () => {
		const results = [
			resultFor({ rowID: "present", confidence: 0.2 }),
			resultFor({ rowID: "absent", stratum: "gold_absent", confidence: 0.9, correct: false }),
		]

		const [point] = thresholdCurve("mailwoman", results, PANEL, [0])
		const unthresholded = armMetrics("mailwoman", "pooled", PANEL, results)

		expect(point?.withheld).toBe(0)
		expect(point?.metrics.selectionAccuracy).toStrictEqual(unthresholded.selectionAccuracy)
		expect(point?.metrics.falseSelection).toStrictEqual(unthresholded.falseSelection)
		expect(point?.metrics.wrongArea).toStrictEqual(unthresholded.wrongArea)
	})

	it("counts the withheld-gold selections no threshold can withhold", () => {
		const ceiling = irreducibleFalseSelections(
			[
				resultFor({ rowID: "absent", stratum: "gold_absent", confidence: 1, correct: false }),
				resultFor({ rowID: "absent", stratum: "gold_absent", confidence: 0.4, correct: false }),
			],
			PANEL
		)

		expect(ceiling).toStrictEqual({ count: 1, of: 2 })
	})

	it("requires both axes before it calls a threshold dominating", () => {
		const results = [
			resultFor({ rowID: "present", confidence: 0.2 }),
			resultFor({ rowID: "absent", stratum: "gold_absent", confidence: 0.2, correct: false }),
		]

		const curve = thresholdCurve("mailwoman", results, PANEL, [0, 0.5])

		// Threshold 0 wins accuracy and loses false selection. 0.5 does the inverse.
		// Neither dominates a reference sitting between them, which is what stops
		// either endpoint from being reported as a win.
		expect(dominatingPoints(curve, { selectionAccuracy: 0.5, falseSelectionRate: 0.5 })).toStrictEqual([])
	})
})
