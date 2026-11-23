// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { describe, expect, it } from "vitest"

import {
	createProminentCoverageTables,
	type EpochRates,
	evaluateProminentCoverage,
	PROMINENT_PLACES_RECORD_VERSION,
} from "#tools/training/audits/prominent/coverage"

import { apportionUnderCap, type DemandCellPlan, readSizingCells, solveRecipeRows } from "./tuples.ts"

describe("readSizingCells", () => {
	it("sizes a cell against the target the receipt grades it by, with a held-out place out of its population", async () => {
		await using directory = await temporaryDirectory("prominent-sizing-")
		const path = directory.path.toString()

		{
			using db = await openDuckDB()

			// GB's Alpha (decile 1, required), Beta (decile 2, held out by design) and Gamma
			// (decile 9), 1,000 people each, as Babeldaob South sat in PW's decile 2 on v0.8.22.
			await db.run(
				"COPY (SELECT * FROM (VALUES " +
					"(1, 'GB', 'locality', 'Alpha', 'alpha', 1, 1, true, false, 'importance', NULL, NULL, NULL, 1000, NULL, NULL, []::VARCHAR[], 'none', false), " +
					"(2, 'GB', 'locality', 'Beta', 'beta', 2, 2, false, false, 'importance', NULL, NULL, NULL, 1000, NULL, NULL, []::VARCHAR[], 'none', false), " +
					"(3, 'GB', 'locality', 'Gamma', 'gamma', 9, 9, false, false, 'importance', NULL, NULL, NULL, 1000, NULL, NULL, []::VARCHAR[], 'none', false)" +
					") AS t(spr_id, country, band, name, fold, decile, rank, by_rank, capital, score_source, geonames_check, geonames_km, " +
					`geonames_id, population_used, parent_locality, region, region_abbrs, postal_evidence, postal_pair)) TO '${path}/places.parquet' (FORMAT PARQUET)`
			)

			// Alpha takes 1 of the cell's 10 draws, short of either target.
			await db.run(
				"COPY (SELECT * FROM (VALUES ('GB', 'wof-admin', 'locality', 'alpha', NULL, NULL::VARCHAR, 1::BIGINT), " +
					"('GB', 'wof-admin', 'locality', 'gamma', NULL, NULL, 9)) AS t(country, source, shape, s1, s2, s3, rows)) " +
					`TO '${path}/short-admin-rows.parquet' (FORMAT PARQUET)`
			)
		}

		await writeLocalTextFile(
			stringifyJSON({
				version: PROMINENT_PLACES_RECORD_VERSION,
				places_sha256: await sha256File(`${path}/places.parquet`),
			}),
			`${path}/PLACES.json`
		)

		const rates: EpochRates = {
			draws: 100,
			perAdmittedRow: new Map([["wof-admin", 1]]),
			admission: new Map([["GB", 1]]),
		}

		const input = { places: `${path}/places.parquet`, shortAdminRows: `${path}/short-admin-rows.parquet`, rates }
		const heldOut = new Set([2])

		using sizing = await openDuckDB()

		const sized = (await readSizingCells(sizing, { ...input, heldOut })).find((cell) => cell.query_shape === "bare")

		using receipt = await openDuckDB()

		await createProminentCoverageTables(receipt, input.places, input.shortAdminRows, rates, heldOut)

		const graded = (await evaluateProminentCoverage(receipt)).demand_share.failing.find(
			(cell) => cell.query_shape === "bare"
		)

		// Without Beta decile 1 holds 1,000 of 2,000 people, a target of 0.25.
		// With Beta it would be 1,000 of 3,000.
		expect(sized?.target).toBeCloseTo(0.25)
		expect(sized?.target).toBe(graded?.target)
	})
})

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
