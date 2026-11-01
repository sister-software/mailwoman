// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import type { BatteryReport, BatteryRowResult } from "#tools/eval-harness/battery/battery"
import {
	agreementQuorum,
	compareCell,
	compareRunGroups,
	detectableDifference,
	formatGroupComparison,
	holmAdjust,
	twoSidedTP,
} from "#tools/eval-harness/battery/groups"

function row(country: string, right: Record<string, boolean>, labelConvention: string | null = null): BatteryRowResult {
	return {
		raw: `${country} row`,
		country,
		labelConvention,
		expected: "street=a",
		got: {},
		right,
		rightUncorrected: right,
		corrections: {},
		cause: {},
	} as BatteryRowResult
}

const control = { name: "control", runs: ["c1", "c2", "c3"] }
const candidate = { name: "candidate", runs: ["n1", "n2"] }

describe("holmAdjust", () => {
	it("multiplies the smallest p by the count and keeps the adjusted values monotone", () => {
		expect(holmAdjust([0.01, 0.04, 0.03])).toEqual([0.03, 0.06, 0.06])
	})

	it("caps an adjusted value at 1", () => {
		expect(holmAdjust([0.6, 0.9])).toEqual([1, 1])
	})
})

describe("twoSidedTP", () => {
	it("is 1 at t = 0 and falls with |t|", () => {
		expect(twoSidedTP(0, 3)).toBeCloseTo(1, 10)
		expect(twoSidedTP(3.182, 3)).toBeCloseTo(0.05, 3)
	})
})

describe("agreementQuorum", () => {
	it("needs every run of a group of two and all but one of a group of three", () => {
		expect([1, 2, 3, 4].map(agreementQuorum)).toEqual([1, 2, 2, 3])
	})
})

describe("compareCell", () => {
	it("counts a row moved only when the groups' quorums agree against each other", () => {
		const rows = [
			// Two of three control runs right, both candidate runs wrong: regressed.
			row("AA", { c1: true, c2: true, c3: false, n1: false, n2: false }),
			// One candidate run right: below the candidate's quorum of two, so not moved.
			row("AA", { c1: true, c2: true, c3: true, n1: true, n2: false }),
			// Every control run wrong, both candidate runs right: improved.
			row("AA", { c1: false, c2: false, c3: false, n1: true, n2: true }),
		]

		const cell = compareCell("AA", rows, control, candidate)

		expect([cell.regressed, cell.improved]).toEqual([1, 1])
		expect(cell.meanA).toBeCloseTo(5 / 9, 10)
		expect(cell.meanB).toBeCloseTo(3 / 6, 10)
	})

	it("reads a difference no run spread explains as significant, and identical groups as no difference", () => {
		const rows = Array.from({ length: 400 }, (_, i) =>
			row("AA", { c1: i < 300, c2: i < 300, c3: i < 300, n1: i < 200, n2: i < 200 })
		)

		const moved = compareCell("AA", rows, control, candidate)

		expect(moved.difference).toBeCloseTo(-0.25, 10)
		// Three degrees of freedom bound how small p can get, even with no spread between runs.
		expect(moved.p).toBeLessThan(0.01)

		const same = compareCell(
			"AA",
			rows.map((r) => row("AA", { ...r.right, n1: r.right.c1!, n2: r.right.c1! })),
			control,
			candidate
		)

		expect(same.difference).toBe(0)
		expect(same.p).toBe(1)
	})
})

describe("compareRunGroups", () => {
	const report: BatteryReport = {
		arms: ["c1", "c2", "c3", "n1", "n2"].map((name) => ({ name, cache: `/cache/${name}` })),
		baseline: "c1",
		seeds: [],
		suites: {
			"suite-x": {
				rows: [
					...Array.from({ length: 250 }, (_, i) =>
						row("AA", { c1: i % 2 === 0, c2: i % 2 === 0, c3: i % 3 === 0, n1: i % 2 === 0, n2: i % 3 === 0 })
					),
					...Array.from({ length: 50 }, () => row("BB", { c1: true, c2: true, c3: true, n1: true, n2: true })),
					row("AA", { c1: true, c2: true, c3: true, n1: false, n2: false }, "convention"),
				],
			},
		},
	}

	it("reads decision rows only and tests only countries with enough rows", () => {
		const comparison = compareRunGroups(report, control, candidate, { minimumCountryRows: 100 })

		expect(comparison.total.rows).toBe(300)
		expect(comparison.countries.map((c) => c.label)).toEqual(["AA"])
		expect(comparison.regroupings).toHaveLength(10)
		expect(comparison.regroupings.filter((r) => r.observed)).toHaveLength(1)
	})

	it("refuses a run the report lacks or a run in both groups", () => {
		expect(() => compareRunGroups(report, control, { name: "x", runs: ["n9"] })).toThrow(/n9 is not an arm/u)
		expect(() => compareRunGroups(report, control, { name: "x", runs: ["c1"] })).toThrow(/in both/u)
	})

	it("detects a smaller difference with more runs per arm", () => {
		const comparison = compareRunGroups(report, control, candidate, { minimumCountryRows: 100 })
		const byRuns = comparison.detectable[0]!.byRuns.map((d) => d.difference)

		expect(byRuns[0]).toBeGreaterThan(byRuns[3]!)
		expect(detectableDifference(comparison.total, 3)).toBe(byRuns[1])
		expect(formatGroupComparison(comparison)).toContain("## By country")
	})
})
