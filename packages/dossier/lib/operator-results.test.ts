/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { ExplanationKind, type OperatorDisposition, type OperatorResult } from "#explanations"
import { operatorResultStatements, reportOperatorResults } from "#operator-results"

/**
 * A synthetic disposition on one check.
 *
 * Each result cites the log `result-<id>` for the disposition's id.
 */
function disposition(id: string, result?: Omit<OperatorResult, "at" | "evidence">): OperatorDisposition {
	return {
		id,
		check: "house-fiber",
		investigated: ExplanationKind.Route,
		decision: "Request the provider's plant record for cell-9",
		decidedAt: "2022-06-01",
		evidence: { source: "operator-log", observedAt: null, validFrom: null, validTo: null },
		result: result
			? {
					...result,
					at: "2022-06-20",
					evidence: { source: `result-${id}`, observedAt: null, validFrom: null, validTo: null },
				}
			: null,
	}
}

describe("reportOperatorResults", () => {
	test("with zero dispositions, blocker accuracy and time saved are unknown", () => {
		expect(reportOperatorResults([])).toEqual({
			dispositions: 0,
			pending: 0,
			pendingSources: [],
			blockerAccuracy: { status: "unknown", reason: "no disposition records an result" },
			timeSaved: {
				status: "unknown",
				reason: "no result records both the minutes spent and the operator's baseline",
			},
		})
	})

	test("dispositions that await an result are counted with their records and leave both measures unknown", () => {
		expect(
			reportOperatorResults([
				disposition("d1"),
				{
					...disposition("d2"),
					evidence: { source: "operator-log-2", observedAt: null, validFrom: null, validTo: null },
				},
			])
		).toMatchObject({
			dispositions: 2,
			pending: 2,
			pendingSources: ["operator-log", "operator-log-2"],
			blockerAccuracy: { status: "unknown" },
			timeSaved: { status: "unknown" },
		})
	})

	test("blocker accuracy counts the investigated explanations that held over every recorded result", () => {
		const report = reportOperatorResults([
			disposition("d1", { held: true, minutesSpent: null, baselineMinutes: null }),
			disposition("d2", { held: false, minutesSpent: null, baselineMinutes: null }),
			disposition("d3", { held: true, minutesSpent: null, baselineMinutes: null }),
			disposition("d4"),
		])

		expect(report).toMatchObject({ dispositions: 4, pending: 1 })

		expect(report.blockerAccuracy).toEqual({
			status: "measured",
			held: 2,
			denominator: 3,
			sources: ["result-d1", "result-d2", "result-d3"],
		})
	})

	test("time saved sums the baseline less the minutes spent over the results that record both", () => {
		const report = reportOperatorResults([
			disposition("d1", { held: true, minutesSpent: 30, baselineMinutes: 90 }),
			disposition("d2", { held: false, minutesSpent: 50, baselineMinutes: 40 }),
			disposition("d3", { held: true, minutesSpent: 20, baselineMinutes: null }),
		])

		expect(report.timeSaved).toEqual({
			status: "measured",
			minutes: 50,
			denominator: 2,
			sources: ["result-d1", "result-d2"],
		})

		expect(report.blockerAccuracy).toMatchObject({ status: "measured", held: 2, denominator: 3 })
	})
})

describe("operatorResultStatements", () => {
	test("a measured accuracy and time saved are estimates that state their denominators", () => {
		const statements = operatorResultStatements(
			reportOperatorResults([
				disposition("d1", { held: true, minutesSpent: 30, baselineMinutes: 90 }),
				disposition("d2", { held: false, minutesSpent: null, baselineMinutes: null }),
				disposition("d3"),
			])
		)

		expect(statements).toEqual([
			{
				kind: "estimate",
				text: "The investigated explanation held in 1 of 2 dispositions with a recorded result.",
				sources: ["result-d1", "result-d2"],
				absence: false,
			},
			{
				kind: "estimate",
				text: "Against the operator's baselines, the investigations saved 60 minutes over 1 result that records both times.",
				sources: ["result-d1"],
				absence: false,
			},
			{ kind: "fact", text: "1 of 3 dispositions awaits an result.", sources: ["operator-log"], absence: false },
		])
	})

	test("time spent beyond the baseline is stated as time lost, not as negative savings", () => {
		expect(
			operatorResultStatements(
				reportOperatorResults([disposition("d1", { held: true, minutesSpent: 50, baselineMinutes: 40 })])
			)
		).toContainEqual({
			kind: "estimate",
			text: "Against the operator's baselines, the investigations took 10 minutes longer over 1 result that records both times.",
			sources: ["result-d1"],
			absence: false,
		})
	})

	test("with zero results, each unknown measure is a deduction that states the missing record as an absence", () => {
		expect(operatorResultStatements(reportOperatorResults([]))).toEqual([
			{
				kind: "deduction",
				text: "Blocker accuracy is unknown because no disposition records an result.",
				sources: [],
				absence: true,
			},
			{
				kind: "deduction",
				text: "Time saved is unknown because no result records both the minutes spent and the operator's baseline.",
				sources: [],
				absence: true,
			},
		])
	})
})
