/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { UnitStage } from "@mailwoman/dossier"
import { DISTRICT_RECORDS, DISTRICT_SCENARIO } from "@mailwoman/opportunity-map/example-district"
import { CostCategory } from "@mailwoman/route-scenarios"
import { describe, expect, test } from "vitest"

import {
	CONTROLS_BASIS,
	controlDefaults,
	controlText,
	type ControlValues,
	dossierFor,
	inputRows,
	parseControls,
	scenarioFor,
} from "#controls"

const defaults = controlDefaults(DISTRICT_SCENARIO)

describe("controlDefaults", () => {
	test("reads each control's value from the scenario", () => {
		expect(defaults).toEqual({
			costAdjustmentBasisPoints: 0,
			takeRateBasisPoints: 5000,
			monthlyPrice: 5500,
			dossierDate: "2026-09-30",
			unitStage: UnitStage.Completed,
			monthZero: "2026-10-01",
			discountRateBasisPoints: 1000,
			horizonMonths: 48,
		})
	})

	test("refuses a scenario whose plans name two unit stages, because one control holds one stage", () => {
		const mixed = {
			...DISTRICT_SCENARIO,
			buildings: DISTRICT_SCENARIO.buildings.map((plan, index) =>
				index ? plan : { ...plan, unitStage: UnitStage.Planned }
			),
		}

		expect(() => controlDefaults(mixed)).toThrow(/2 unit stages/)
	})
})

describe("scenarioFor", () => {
	test("leaves the scenario as it is at the default values", () => {
		expect(scenarioFor(DISTRICT_SCENARIO, defaults)).toEqual(DISTRICT_SCENARIO)
	})

	test("sets each changed input and gives the inputs that carry a basis the controls' basis", () => {
		const changed: ControlValues = {
			costAdjustmentBasisPoints: 1000,
			takeRateBasisPoints: 4000,
			monthlyPrice: 4500,
			dossierDate: "2026-12-31",
			unitStage: UnitStage.Planned,
			monthZero: "2027-01-01",
			discountRateBasisPoints: 800,
			horizonMonths: 60,
		}

		const scenario = scenarioFor(DISTRICT_SCENARIO, changed)

		expect(scenario.costAdjustment).toEqual({
			label: "every construction line 10.00% over the rate card, set in the scenario controls",
			basisPoints: 1000,
			categories: Object.values(CostCategory),
		})

		expect(scenario.operating.uptake).toEqual({
			...DISTRICT_SCENARIO.operating.uptake,
			takeRateBasisPoints: 4000,
			basis: CONTROLS_BASIS,
		})

		expect(scenario.operating.prices).toEqual([{ fromMonth: 0, amount: 4500, basis: CONTROLS_BASIS }])
		expect(scenario.asOf).toBe("2026-12-31")

		expect(scenario.buildings.map((plan) => plan.unitStage)).toEqual([
			UnitStage.Planned,
			UnitStage.Planned,
			UnitStage.Planned,
		])

		expect(scenario.monthZero).toBe("2027-01-01")
		expect(scenario.annualDiscountRateBasisPoints).toBe(800)
		expect(scenario.horizonMonths).toBe(60)

		// Every input the controls do not hold is the scenario's own.
		expect({ ...scenario, costAdjustment: null, operating: DISTRICT_SCENARIO.operating }).toEqual({
			...DISTRICT_SCENARIO,
			asOf: "2026-12-31",
			buildings: scenario.buildings,
			monthZero: "2027-01-01",
			annualDiscountRateBasisPoints: 800,
			horizonMonths: 60,
		})
	})

	test("a cost adjustment of zero states no adjustment, and a negative one lowers every construction line", () => {
		expect(scenarioFor(DISTRICT_SCENARIO, { ...defaults, costAdjustmentBasisPoints: 0 }).costAdjustment).toBeNull()

		expect(
			scenarioFor(DISTRICT_SCENARIO, { ...defaults, costAdjustmentBasisPoints: -1250 }).costAdjustment?.label
		).toBe("every construction line 12.50% under the rate card, set in the scenario controls")
	})
})

describe("dossierFor", () => {
	test("admits the records available on the dossier date", () => {
		expect(dossierFor(DISTRICT_RECORDS, defaults).admitted).toHaveLength(5)

		expect(
			dossierFor(DISTRICT_RECORDS, { ...defaults, dossierDate: "2026-08-02" }).excluded.map((record) => record.id)
		).toEqual(["synthetic-inspection-2026"])
	})
})

describe("controlText and parseControls", () => {
	test("write the defaults in each control's unit and read them back unchanged", () => {
		const text = controlText(defaults, "USD")

		expect(text).toEqual({
			costAdjustment: "0",
			takeRate: "50",
			monthlyPrice: "55.00",
			dossierDate: "2026-09-30",
			unitStage: "completed",
			monthZero: "2026-10",
			discountRate: "10",
			horizon: "48",
		})

		expect(parseControls(text, "USD")).toEqual({ ok: true, values: defaults })
	})

	test("read decimals exactly in basis points and minor units", () => {
		const parsed = parseControls(
			{
				...controlText(defaults, "USD"),
				costAdjustment: "-7.5",
				takeRate: "12.34",
				monthlyPrice: "45.5",
				discountRate: "8",
			},
			"USD"
		)

		expect(parsed).toMatchObject({
			ok: true,
			values: {
				costAdjustmentBasisPoints: -750,
				takeRateBasisPoints: 1234,
				monthlyPrice: 4550,
				discountRateBasisPoints: 800,
			},
		})
	})

	test("refuse text that does not read in its unit and name each field", () => {
		const parsed = parseControls(
			{
				costAdjustment: "12.345",
				takeRate: "fifty",
				monthlyPrice: "55.001",
				dossierDate: "2026-02-30x",
				unitStage: "occupied soon",
				monthZero: "2026-13",
				discountRate: "",
				horizon: "4.5",
			},
			"USD"
		)

		expect(parsed.ok).toBe(false)

		if (parsed.ok) return

		expect(Object.keys(parsed.errors).toSorted()).toEqual([
			"costAdjustment",
			"discountRate",
			"dossierDate",
			"horizon",
			"monthZero",
			"monthlyPrice",
			"takeRate",
			"unitStage",
		])
	})
})

describe("inputRows", () => {
	const dossier = dossierFor(DISTRICT_RECORDS, defaults)

	test("states each input with the basis the scenario gives it", () => {
		expect(inputRows(DISTRICT_SCENARIO, DISTRICT_SCENARIO, dossier, DISTRICT_RECORDS)).toEqual([
			{ input: "Cost adjustment", value: "none: the rate card as stated", basis: "stated by the scenario" },
			{
				input: "Take rate",
				value: "50.00% of occupied units over 4 months",
				basis: "operator assumption stated by synthetic example for #2289",
			},
			{
				input: "Monthly price",
				value: "USD 55.00 per subscriber from month 0",
				basis: "operator assumption stated by synthetic example for #2289",
			},
			{
				input: "Dossier date",
				value: "2026-09-30",
				basis: "the dossier admits 5 of 5 source records by their availability dates",
			},
			{ input: "Unit stage", value: "completed", basis: "stated by the scenario's building plans" },
			{ input: "Month zero", value: "2026-10", basis: "convention stated by the scenario" },
			{ input: "Discount rate", value: "10.00% effective annual", basis: "convention stated by the scenario" },
			{ input: "Horizon", value: "48 months", basis: "convention stated by the scenario" },
		])
	})

	test("names the controls as the basis of every changed input", () => {
		const scenario = scenarioFor(DISTRICT_SCENARIO, {
			...defaults,
			costAdjustmentBasisPoints: 1000,
			takeRateBasisPoints: 4000,
			monthlyPrice: 4500,
			unitStage: UnitStage.Occupied,
			monthZero: "2027-01-01",
			discountRateBasisPoints: 800,
			horizonMonths: 60,
		})

		expect(
			inputRows(DISTRICT_SCENARIO, scenario, dossier, DISTRICT_RECORDS).map((row) => [row.value, row.basis])
		).toEqual([
			["+10.00% on every construction line", "set in the scenario controls"],
			["40.00% of occupied units over 4 months", "operator assumption stated by the scenario controls"],
			["USD 45.00 per subscriber from month 0", "operator assumption stated by the scenario controls"],
			["2026-09-30", "the dossier admits 5 of 5 source records by their availability dates"],
			["occupied", "set in the scenario controls"],
			["2027-01", "convention set in the scenario controls"],
			["8.00% effective annual", "convention set in the scenario controls"],
			["60 months", "convention set in the scenario controls"],
		])
	})
})
