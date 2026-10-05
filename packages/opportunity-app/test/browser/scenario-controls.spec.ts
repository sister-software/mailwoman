/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Item 4 of #2289: "Scenario controls update investment, value, evidence, dates, and assumptions." Each case
 *   changes one control with Example Buildings A, B and C selected. The test builds the changed scenario itself,
 *   asks `selectionEconomics` for its figures, and compares every displayed figure with them. When the model
 *   refuses the changed scenario, the page must show the refusal's message in place of figures.
 *
 *   The two evidence controls also change each building's state and denominator, and each district's sums, so
 *   those cases compare the building list and the district table with `buildingFeatures` and `districtFeatures`.
 */

import { type ISODate, UnitStage } from "@mailwoman/dossier"
import { buildingFeatures, type DistrictPlacement, districtFeatures } from "@mailwoman/opportunity-map"
import { BUILDING_A, BUILDING_B, BUILDING_C, DISTRICT_SCENARIO } from "@mailwoman/opportunity-map/example-district"
import { CostCategory, renderScenarioReport, type Scenario, scenarioReport } from "@mailwoman/route-scenarios"
import type { Page } from "@playwright/test"

import { COST_AND_VALUE_ANCHOR, dossierAnchor, REPORT_OPTIONS } from "#evidence"

import {
	buildingLabels,
	districtDossierOn,
	expect,
	expectRecalculation,
	figureRows,
	literalPattern,
	recalculate,
	stateWords,
	test,
	unitsWords,
} from "../e2e/opportunity.ts"

const SELECTION = [BUILDING_A, BUILDING_B, BUILDING_C]
const EXTENT_KIND = "example-district"
const SCENARIO_DATE: ISODate = DISTRICT_SCENARIO.asOf

/**
 * The row header of a district: its extent, or the words for the buildings no single extent places.
 */
function districtRowHeader(extent: string | null, placement: DistrictPlacement): string {
	if (extent !== null) return extent

	return placement === "unplaced"
		? `Buildings with no ${EXTENT_KIND} membership`
		: `Buildings with two or more ${EXTENT_KIND} memberships`
}

/**
 * One control change: the control, what the test enters, and the scenario and dossier the change produces.
 */
interface ControlCase {
	/**
	 * The word of item 4 that the control covers.
	 */
	covers: "investment" | "value" | "evidence" | "dates" | "assumptions"
	label: string
	/**
	 * The text the test types, or the option it selects for a select element.
	 */
	entry: string
	select?: boolean
	/**
	 * The inputs table row of the changed input after the change.
	 */
	input: { name: string; value: string; basis: RegExp }
	dossierDate: ISODate
	unitStage: UnitStage
	scenario: Scenario
}

const CASES: readonly ControlCase[] = [
	{
		covers: "investment",
		label: "Cost adjustment, percent of the rate card",
		entry: "10",
		input: {
			name: "Cost adjustment",
			value: "+10.00% on every construction line",
			basis: /set in the scenario controls/,
		},
		dossierDate: SCENARIO_DATE,
		unitStage: UnitStage.Completed,
		scenario: {
			...DISTRICT_SCENARIO,
			costAdjustment: { label: "test", basisPoints: 1000, categories: Object.values(CostCategory) },
		},
	},
	{
		covers: "value",
		label: "Take rate, percent of occupied units",
		entry: "40",
		input: {
			name: "Take rate",
			value: "40.00% of occupied units over 4 months",
			basis: /stated by the scenario controls/,
		},
		dossierDate: SCENARIO_DATE,
		unitStage: UnitStage.Completed,
		scenario: {
			...DISTRICT_SCENARIO,
			operating: {
				...DISTRICT_SCENARIO.operating,
				uptake: { ...DISTRICT_SCENARIO.operating.uptake, takeRateBasisPoints: 4000 },
			},
		},
	},
	{
		covers: "value",
		label: "Monthly price from month 0, USD",
		entry: "45.00",
		input: {
			name: "Monthly price",
			value: "USD 45.00 per subscriber from month 0",
			basis: /stated by the scenario controls/,
		},
		dossierDate: SCENARIO_DATE,
		unitStage: UnitStage.Completed,
		scenario: {
			...DISTRICT_SCENARIO,
			operating: {
				...DISTRICT_SCENARIO.operating,
				prices: DISTRICT_SCENARIO.operating.prices.map((step) =>
					step.fromMonth === 0 ? { ...step, amount: 4500 } : step
				),
			},
		},
	},
	{
		covers: "evidence",
		label: "Dossier date",
		entry: "2026-08-02",
		input: { name: "Dossier date", value: "2026-08-02", basis: /admits 4 of 5 source records/ },
		dossierDate: "2026-08-02",
		unitStage: UnitStage.Completed,
		scenario: { ...DISTRICT_SCENARIO, asOf: "2026-08-02" },
	},
	{
		covers: "evidence",
		label: "Unit stage",
		entry: "planned",
		select: true,
		input: { name: "Unit stage", value: "planned", basis: /set in the scenario controls/ },
		dossierDate: SCENARIO_DATE,
		unitStage: UnitStage.Planned,
		scenario: {
			...DISTRICT_SCENARIO,
			buildings: DISTRICT_SCENARIO.buildings.map((plan) => ({ ...plan, unitStage: UnitStage.Planned })),
		},
	},
	{
		covers: "dates",
		label: "Month zero",
		entry: "2027-01",
		input: { name: "Month zero", value: "2027-01", basis: /set in the scenario controls/ },
		dossierDate: SCENARIO_DATE,
		unitStage: UnitStage.Completed,
		scenario: { ...DISTRICT_SCENARIO, monthZero: "2027-01-01" },
	},
	{
		covers: "assumptions",
		label: "Discount rate, effective annual percent",
		entry: "8",
		input: { name: "Discount rate", value: "8.00% effective annual", basis: /set in the scenario controls/ },
		dossierDate: SCENARIO_DATE,
		unitStage: UnitStage.Completed,
		scenario: { ...DISTRICT_SCENARIO, annualDiscountRateBasisPoints: 800 },
	},
	{
		covers: "assumptions",
		label: "Horizon in months",
		entry: "60",
		input: { name: "Horizon", value: "60 months", basis: /set in the scenario controls/ },
		dossierDate: SCENARIO_DATE,
		unitStage: UnitStage.Completed,
		scenario: { ...DISTRICT_SCENARIO, horizonMonths: 60 },
	},
]

async function selectBuildings(page: Page, labels: ReadonlyMap<string, string>): Promise<void> {
	for (const building of SELECTION) {
		await page.getByRole("checkbox", { name: labels.get(building), exact: true }).check()
	}
}

/**
 * The cells after the row header of the inputs table row named `name`.
 */
function inputCells(page: Page, name: string) {
	return page
		.getByRole("table", { name: "Scenario inputs and their bases" })
		.getByRole("row")
		.filter({ has: page.getByRole("rowheader", { name, exact: true }) })
		.getByRole("cell")
}

test("each scenario control recalculates the selection through selectionEconomics", async ({ page }) => {
	const baseDossier = districtDossierOn(SCENARIO_DATE)
	const labels = buildingLabels(baseDossier)
	const before = recalculate(baseDossier, DISTRICT_SCENARIO, SELECTION)

	expect(before.kind, "the unchanged scenario yields figures").toBe("figures")

	const covered = new Set<string>()

	for (const control of CASES) {
		await test.step(`${control.covers}: ${control.label} = ${control.entry}`, async () => {
			await page.goto("/")
			await selectBuildings(page, labels)
			await expectRecalculation(page, before, DISTRICT_SCENARIO, labels)

			const field = page.getByLabel(control.label, { exact: true })

			await (control.select ? field.selectOption(control.entry) : field.fill(control.entry))
			await page.getByRole("button", { name: "Recalculate" }).click()

			const dossier = districtDossierOn(control.dossierDate)
			const after = recalculate(dossier, control.scenario, SELECTION)

			// A case whose figures equal the unchanged scenario's would leave its control untested.
			expect(
				after.kind === "figures" ? figureRows(after.economics, control.scenario, labels) : after,
				"the change moves a displayed figure or replaces the figures with a refusal"
			).not.toEqual(before.kind === "figures" ? figureRows(before.economics, DISTRICT_SCENARIO, labels) : before)

			await expectRecalculation(page, after, control.scenario, labels)
			await expect(inputCells(page, control.input.name)).toHaveText([control.input.value, control.input.basis])

			if (control.covers === "evidence") {
				for (const feature of buildingFeatures(dossier, { unitStage: control.unitStage }).features) {
					const { label, state, units } = feature.properties

					await expect(page.getByRole("checkbox", { name: label, exact: true })).toHaveAccessibleDescription(
						new RegExp(`${literalPattern(stateWords(state))}.*${literalPattern(unitsWords(units))}`, "u")
					)
				}

				await page.getByRole("radio", { name: "Districts" }).check()

				const districts = page.getByRole("table", { name: `Districts by ${EXTENT_KIND}` })
				const collection = districtFeatures(dossier, { unitStage: control.unitStage, extentKind: EXTENT_KIND })

				await expect(districts.getByRole("rowheader")).toHaveText(
					collection.features.map((district) =>
						districtRowHeader(district.properties.extent, district.properties.placement)
					)
				)

				for (const district of collection.features) {
					const { extent, placement, units } = district.properties
					const name = districtRowHeader(extent, placement)

					const cells = districts
						.getByRole("row")
						.filter({ has: page.getByRole("rowheader", { name, exact: true }) })
						.getByRole("cell")

					await expect(cells.nth(1)).toHaveText(String(units.resolved))
					await expect(cells.nth(2)).toHaveText(String(units.unresolvedBuildings))
				}
			}

			covered.add(control.covers)
		})
	}

	expect([...covered].toSorted()).toEqual(["assumptions", "dates", "evidence", "investment", "value"])
})

test("a selection links to each building's dossier part and to its cost and value report", async ({ page }) => {
	const dossier = districtDossierOn(SCENARIO_DATE)
	const labels = buildingLabels(dossier)

	await page.goto("/")
	await selectBuildings(page, labels)

	const links = page.getByRole("navigation", { name: "Evidence for the selection" }).getByRole("link")

	await expect(links).toHaveText([
		...SELECTION.map((building) => `Dossier part: ${labels.get(building)}`),
		"Cost and value report for the selection",
	])

	for (const building of SELECTION) {
		const label = labels.get(building)!

		await expect(page.getByRole("link", { name: `Dossier part: ${label}` })).toHaveAttribute(
			"href",
			`#${dossierAnchor(building)}`
		)

		await expect(page.locator(`#${dossierAnchor(building)} pre`)).toContainText(`## ${label}`)
	}

	await expect(page.getByRole("link", { name: "Cost and value report for the selection" })).toHaveAttribute(
		"href",
		`#${COST_AND_VALUE_ANCHOR}`
	)

	const report = renderScenarioReport(
		scenarioReport(dossier, { ...DISTRICT_SCENARIO, selected: SELECTION }, REPORT_OPTIONS)
	)

	await expect(page.locator(`#${COST_AND_VALUE_ANCHOR} pre`)).toHaveText(report)
	expect(report).toContain("Every input in this section is synthetic.")
})
