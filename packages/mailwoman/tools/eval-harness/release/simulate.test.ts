import { describe, expect, it } from "vitest"

import { type SimulationScenario, simulateScenario } from "#tools/eval-harness/release/simulate"

const scenario = (overrides: Partial<SimulationScenario> = {}): SimulationScenario => ({
	id: "test",
	description: "test",
	countries: [
		// Large enough that an all-exact country's exact lower bound clears 0.9; at 20 and 30 rows it does not.
		{ country: "AA", rows: 200, published: 1, candidate: 1, minimum: 0.9 },
		{
			country: "BB",
			rows: 300,
			published: 0,
			candidate: 1,
			discordance: 1,
			minimum: 0.9,
		},
	],
	minimumImprovement: 0,
	confidenceLevel: 0.95,
	grouping: "metadata",
	...overrides,
})

describe("simulateScenario", () => {
	it("reports exact coverage and decisions on a zero-variance scenario", () => {
		const report = simulateScenario(scenario(), 5, 1)

		expect(report.truthImprovement).toBe(0.5)
		expect(report.truthMeetsAll).toBe(true)
		expect(report.jointCoverage.rate).toBe(1)

		for (const check of report.checks) {
			expect(check.coverage.count).toBe(5)
		}

		expect(report.pass.count).toBe(5)
		expect(report.erroneousFail?.count).toBe(0)
		expect(report.erroneousApproval).toBeNull()
	})

	it("does not pass a small all-exact sample whose true rate misses the minimum", () => {
		const report = simulateScenario(
			scenario({
				countries: [{ country: "AA", rows: 10, published: 0.85, candidate: 0.85, discordance: 0.1, minimum: 0.9 }],
				minimumImprovement: -0.05,
			}),
			100,
			2763
		)

		expect(report.truthMeetsAll).toBe(false)
		expect(report.erroneousApproval?.count).toBe(0)
	})

	it("refuses to bound ungrouped rows the specification does not declare independent", () => {
		const report = simulateScenario(scenario({ grouping: "row_identity" }), 3, 1)

		expect(report.insufficient.count).toBe(3)
		expect(report.unbounded).toBe(3)
	})

	it("fails every zero-variance evaluation whose truth misses a minimum, with no erroneous approval", () => {
		const report = simulateScenario(
			scenario({
				countries: [
					{
						country: "AA",
						rows: 20,
						published: 1,
						candidate: 0,
						discordance: 1,
						minimum: 0.5,
					},
				],
			}),
			4,
			1
		)

		expect(report.truthMeetsAll).toBe(false)
		expect(report.fail.count).toBe(4)
		expect(report.erroneousApproval?.count).toBe(0)
		expect(report.jointCoverage.count).toBe(4)
	})

	it("is deterministic for a seed and differs across seeds", () => {
		const noisy = scenario({
			countries: [
				{
					country: "AA",
					rows: 40,
					published: 0.7,
					candidate: 0.75,
					discordance: 0.2,
					groupSize: 4,
					correlation: 0.5,
					minimum: 0.6,
				},
			],
		})

		const a = simulateScenario(noisy, 20, 7)

		expect(simulateScenario(noisy, 20, 7)).toEqual(a)
		// Base seeds 7 and 1007 share no repetition seed, since repetition r uses seed + r.
		expect(simulateScenario(noisy, 20, 1007)).not.toEqual(a)
	})

	it("refuses an invalid scenario", () => {
		expect(() =>
			simulateScenario(
				scenario({
					countries: [
						{
							country: "AA",
							rows: 10,
							published: 0.5,
							candidate: 0.9,
							discordance: 0.1,
						},
					],
				}),
				1,
				1
			)
		).toThrow(/infeasible/)

		expect(() => simulateScenario(scenario({ objectiveCountries: ["ZZ"] }), 1, 1)).toThrow(/not simulated/)

		expect(() =>
			simulateScenario(
				scenario({
					countries: [{ country: "AA", rows: 10, published: 1.2, candidate: 0.9 }],
				}),
				1,
				1
			)
		).toThrow(/\[0, 1\]/)

		expect(() =>
			simulateScenario(
				scenario({
					countries: [
						{
							country: "AA",
							rows: 10,
							published: 0.5,
							candidate: 0.5,
							groupSize: 0,
						},
					],
				}),
				1,
				1
			)
		).toThrow(/groupSize/)
	})
})
