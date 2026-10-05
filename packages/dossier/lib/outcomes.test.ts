/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { ExplanationKind, type OperatorDisposition, type OperatorOutcome } from "#explanations"
import { outcomeStatements, reportOutcomes } from "#outcomes"

/**
 * A synthetic disposition on one check.
 *
 * Each outcome cites the log `outcome-<id>` for the disposition's id.
 */
function disposition(id: string, outcome?: Omit<OperatorOutcome, "at" | "evidence">): OperatorDisposition {
	return {
		id,
		check: "house-fiber",
		investigated: ExplanationKind.Route,
		decision: "Request the provider's plant record for cell-9",
		decidedAt: "2022-06-01",
		evidence: { source: "operator-log" },
		outcome: outcome && { ...outcome, at: "2022-06-20", evidence: { source: `outcome-${id}` } },
	}
}

describe("reportOutcomes", () => {
	test("with zero dispositions, blocker accuracy and time saved are unknown", () => {
		expect(reportOutcomes([])).toEqual({
			dispositions: 0,
			pending: 0,
			blockerAccuracy: { status: "unknown", reason: "no disposition records an outcome" },
			timeSaved: {
				status: "unknown",
				reason: "no outcome records both the minutes spent and the operator's baseline",
			},
		})
	})

	test("dispositions that await an outcome are counted and leave both measures unknown", () => {
		expect(reportOutcomes([disposition("d1"), disposition("d2")])).toMatchObject({
			dispositions: 2,
			pending: 2,
			blockerAccuracy: { status: "unknown" },
			timeSaved: { status: "unknown" },
		})
	})

	test("blocker accuracy counts the investigated explanations that held over every recorded outcome", () => {
		const report = reportOutcomes([
			disposition("d1", { held: true }),
			disposition("d2", { held: false }),
			disposition("d3", { held: true }),
			disposition("d4"),
		])

		expect(report).toMatchObject({ dispositions: 4, pending: 1 })

		expect(report.blockerAccuracy).toEqual({
			status: "measured",
			held: 2,
			denominator: 3,
			sources: ["outcome-d1", "outcome-d2", "outcome-d3"],
		})
	})

	test("time saved sums the baseline less the minutes spent over the outcomes that record both", () => {
		const report = reportOutcomes([
			disposition("d1", { held: true, minutesSpent: 30, baselineMinutes: 90 }),
			disposition("d2", { held: false, minutesSpent: 50, baselineMinutes: 40 }),
			disposition("d3", { held: true, minutesSpent: 20 }),
		])

		expect(report.timeSaved).toEqual({
			status: "measured",
			minutes: 50,
			denominator: 2,
			sources: ["outcome-d1", "outcome-d2"],
		})

		expect(report.blockerAccuracy).toMatchObject({ status: "measured", held: 2, denominator: 3 })
	})
})

describe("outcomeStatements", () => {
	test("a measured accuracy and time saved are estimates that state their denominators", () => {
		const statements = outcomeStatements(
			reportOutcomes([
				disposition("d1", { held: true, minutesSpent: 30, baselineMinutes: 90 }),
				disposition("d2", { held: false }),
				disposition("d3"),
			])
		)

		expect(statements).toEqual([
			{
				kind: "estimate",
				text: "The investigated explanation held in 1 of 2 dispositions with a recorded outcome.",
				sources: ["outcome-d1", "outcome-d2"],
			},
			{
				kind: "estimate",
				text: "Against the operator's baselines, the investigations saved 60 minutes over 1 outcome that records both times.",
				sources: ["outcome-d1"],
			},
			{ kind: "fact", text: "1 of 3 dispositions awaits an outcome.", sources: [] },
		])
	})

	test("time spent beyond the baseline is stated as time lost, not as negative savings", () => {
		expect(
			outcomeStatements(reportOutcomes([disposition("d1", { held: true, minutesSpent: 50, baselineMinutes: 40 })]))
		).toContainEqual({
			kind: "estimate",
			text: "Against the operator's baselines, the investigations took 10 minutes longer over 1 outcome that records both times.",
			sources: ["outcome-d1"],
		})
	})

	test("with zero outcomes, each unknown measure is a deduction that names the missing record", () => {
		expect(outcomeStatements(reportOutcomes([]))).toEqual([
			{
				kind: "deduction",
				text: "Blocker accuracy is unknown because no disposition records an outcome.",
				sources: [],
			},
			{
				kind: "deduction",
				text: "Time saved is unknown because no outcome records both the minutes spent and the operator's baseline.",
				sources: [],
			},
		])
	})
})
