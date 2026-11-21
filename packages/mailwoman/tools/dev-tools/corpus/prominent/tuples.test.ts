// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { apportionUnderCap, type DemandCellPlan, solveRecipeRows } from "./tuples.ts"

it("gives no place more than the smallest equal share of a deficit, and the parts sum to the deficit", () => {
	const weights = [8_000_000, 1_000_000, 1_000_000, 500]
	const parts = apportionUnderCap(10, weights)

	expect(parts.reduce((a, b) => a + b, 0)).toBe(10)
	expect(Math.max(...parts)).toBe(Math.ceil(10 / weights.length))
	// The remainder goes to the most populous places.
	expect(parts).toEqual([3, 3, 2, 2])
})

describe("solveRecipeRows", () => {
	const cells: DemandCellPlan[] = [
		// Decile 1 holds 10 of 100 draws against a target of 0.4.
		{ draws: 100, decile1Draws: 10, target: 0.4, presenceRows: 2, decile1PresenceRows: 1, admission: 1 },
		// A cell already past its target.
		// Its presence rows can push it below the target.
		{ draws: 10, decile1Draws: 5, target: 0.45, presenceRows: 3, decile1PresenceRows: 0, admission: 1 },
		{ draws: 40, decile1Draws: 0, target: 0.2, presenceRows: 0, decile1PresenceRows: 0, admission: 0.5 },
	]

	const presenceAdmitted = 5

	it("meets every cell at the draws its own row count gives each recipe row", () => {
		const budget = 400
		const solution = solveRecipeRows(cells, presenceAdmitted, budget)

		const admitted =
			presenceAdmitted + solution.demandRows.reduce((sum, rows, index) => sum + rows * cells[index]!.admission, 0)

		expect(solution.admittedRows).toBeCloseTo(admitted)
		expect(solution.drawsPerAdmittedRow).toBeCloseTo(budget / admitted)

		for (const [index, cell] of cells.entries()) {
			const perRow = solution.drawsPerAdmittedRow * cell.admission
			const rows = solution.demandRows[index]!

			const share =
				(cell.decile1Draws + (cell.decile1PresenceRows + rows) * perRow) /
				(cell.draws + (cell.presenceRows + rows) * perRow)

			expect(share).toBeGreaterThanOrEqual(cell.target - 1e-9)
		}
	})

	it("writes more rows for the same deficits as the budget shrinks", () => {
		const rows = (budget: number) => solveRecipeRows(cells, presenceAdmitted, budget).admittedRows

		expect(rows(200)).toBeGreaterThan(rows(4000))
	})

	it("refuses a budget the deficits alone exhaust", () => {
		expect(() => solveRecipeRows(cells, presenceAdmitted, 50)).toThrow("raise the source's weight")
	})
})

it("divides a deficit smaller than the place count among the most populous places", () => {
	expect(apportionUnderCap(2, [5, 50, 0, 50])).toEqual([0, 1, 0, 1])
	expect(apportionUnderCap(3, [])).toEqual([])
})
