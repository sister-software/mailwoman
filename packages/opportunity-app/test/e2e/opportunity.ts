/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What the browser specs expect from the application, computed by the model for the Example District and
 *   written in the words the application shows. The specs restate each wording here rather than importing the
 *   application's own, so a change of wording on either side fails them.
 *
 *   The `test` export records every request a page makes and fails the test when one leaves the preview server.
 */

import { buildDossier, type Dossier, type EntityID, type ISODate } from "@mailwoman/dossier"
import {
	type BuildingState,
	selectionEconomics,
	type SelectionEconomics,
	type UnitDenominator,
} from "@mailwoman/opportunity-map"
import { DISTRICT_RECORDS } from "@mailwoman/opportunity-map/example-district"
import { calendarMonth, formatMoney, type Scenario } from "@mailwoman/route-scenarios"
import { test as base, expect, type Page } from "@playwright/test"

export { expect } from "@playwright/test"

/**
 * The Playwright `test` with an automatic check that every request stays on the preview server.
 *
 * A data or blob URL never leaves the page, so the check admits both.
 */
export const test = base.extend<{ foreignRequests: string[] }>({
	foreignRequests: [
		async ({ page, baseURL }, use) => {
			const foreign: string[] = []

			page.on("request", (request) => {
				const url = request.url()

				if (!url.startsWith(`${baseURL}/`) && !url.startsWith("data:") && !url.startsWith("blob:")) {
					foreign.push(url)
				}
			})

			await use(foreign)

			expect(foreign, "requests beyond the preview server").toEqual([])
		},
		{ auto: true },
	],
})

/**
 * Joins words as English prose without a serial comma: `a, b and c`.
 */
export const PROSE_LIST = new Intl.ListFormat("en-GB", { style: "long", type: "conjunction" })

/**
 * The dossier the application builds from the Example District's records on a dossier date.
 */
export function districtDossierOn(asOf: ISODate): Dossier {
	return buildDossier(DISTRICT_RECORDS, { asOf })
}

/**
 * Each building's label by identifier, in the dossier's building order.
 */
export function buildingLabels(dossier: Dossier): ReadonlyMap<EntityID, string> {
	return new Map(dossier.buildings.map((section) => [section.building.id, section.building.label]))
}

/**
 * The words of a building state: its wire value with spaces for underscores.
 */
export function stateWords(state: BuildingState): string {
	return state.replaceAll("_", " ")
}

/**
 * A unit denominator as a building row states it.
 * An unresolved total is the word unresolved, never a number.
 */
export function unitsWords(units: UnitDenominator): string {
	return units.total === "unresolved"
		? `Units: unresolved at the ${units.stage} stage`
		: `Units: ${units.total} ${units.stage} units on ${units.at}`
}

/**
 * A month of the scenario with its calendar month, or the words for no month within the horizon.
 */
function monthWords(monthZero: ISODate, month: number | null): string {
	return month === null ? "none within the horizon" : `month ${month} (${calendarMonth(monthZero, month)})`
}

/**
 * The figures `selectionEconomics` returns for a selection, or the message of the error it throws.
 */
export type Recalculation =
	| { kind: "figures"; economics: SelectionEconomics }
	| { kind: "refusal"; name: string; message: string }

export function recalculate(dossier: Dossier, scenario: Scenario, selection: readonly EntityID[]): Recalculation {
	try {
		return { kind: "figures", economics: selectionEconomics(dossier, scenario, selection) }
	} catch (error) {
		if (!(error instanceof Error)) throw error

		return { kind: "refusal", name: error.name, message: error.message }
	}
}

/**
 * The rows of the figures table: each figure's name, its value and its origin.
 */
export function figureRows(
	economics: SelectionEconomics,
	scenario: Scenario,
	labels: ReadonlyMap<EntityID, string>
): (readonly [string, string, string])[] {
	const money = (amount: number) => formatMoney(amount, economics.currency)
	const named = (buildings: readonly EntityID[]) => PROSE_LIST.format(buildings.map((id) => labels.get(id) ?? id))
	const origin = economics.synthetic ? "synthetic" : "operator supplied"
	const { construction, peakFunding } = economics

	return [
		["Selected buildings", named(economics.selection), "selection"],
		["Eligible units", String(economics.units), "dossier unit totals"],
		["Route construction cost", money(construction.route), origin],
		["Project costs", money(construction.project), origin],
		["Common cost", money(construction.common), origin],
		["Direct cost", money(construction.direct), origin],
		["Total construction cost", money(construction.total), origin],
		...economics.segments.map(
			(entry) => [`Segment ${entry.segment}`, `${money(entry.amount)}, used by ${named(entry.usedBy)}`, origin] as const
		),
		["Net present value", money(economics.npv), origin],
		["First revenue", monthWords(scenario.monthZero, economics.firstRevenueMonth), origin],
		["Cash before first revenue", money(economics.cashBeforeFirstRevenue), origin],
		[
			"Peak funding",
			peakFunding.month === null
				? "none: the cumulative cash flow stays at or above zero"
				: `${money(peakFunding.amount)} in ${monthWords(scenario.monthZero, peakFunding.month)}`,
			origin,
		],
	]
}

/**
 * The text the live region announces after a recalculation of a non-empty selection.
 */
export function statusWords(recalculation: Recalculation): string {
	if (recalculation.kind === "refusal") return `Recalculated: no figures. ${recalculation.message}`

	const { economics } = recalculation
	const count = economics.selection.length
	const money = (amount: number) => formatMoney(amount, economics.currency)

	return (
		`Recalculated for ${count} selected ${count === 1 ? "building" : "buildings"}: ` +
		`total construction cost ${money(economics.construction.total)}, ` +
		`net present value ${money(economics.npv)}, ${economics.synthetic ? "synthetic" : "operator supplied"} figures.`
	)
}

/**
 * The row of the figures table whose header is `name`.
 */
function figureRow(page: Page, name: string) {
	return page
		.getByRole("table", { name: "Figures for the selection" })
		.getByRole("row")
		.filter({ has: page.getByRole("rowheader", { name, exact: true }) })
}

/**
 * Asserts the figures section against a recalculation: every figure row, or the refused
 * message in place of figures, and the live region's announcement.
 */
export async function expectRecalculation(
	page: Page,
	recalculation: Recalculation,
	scenario: Scenario,
	labels: ReadonlyMap<EntityID, string>
): Promise<void> {
	const section = page.getByRole("region", { name: "Selection economics" })
	const table = page.getByRole("table", { name: "Figures for the selection" })

	await expect(page.getByRole("status")).toHaveText(statusWords(recalculation))

	if (recalculation.kind === "refusal") {
		await expect(section.getByText(recalculation.message, { exact: true })).toBeVisible()
		await expect(table).toHaveCount(0)

		return
	}

	const rows = figureRows(recalculation.economics, scenario, labels)

	await expect(table.getByRole("rowheader")).toHaveText(rows.map(([name]) => name))

	for (const [name, value, origin] of rows) {
		await expect(figureRow(page, name).getByRole("cell")).toHaveText([value, origin])
	}
}
