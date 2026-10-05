/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Item 5 of #2289: "Keyboard access and more than color identify selection, unknowns, and sources." The test
 *   drives the page with the keyboard alone: Tab, Shift+Tab, Space, Enter and an arrow key. It makes no mouse click,
 *   passes no `force` option and dispatches no scripted event. Every assertion reads a role, an accessible name or
 *   description, or text, and none reads a color. The expected words come from `buildingFeatures`,
 *   `routeFeatures` and `districtFeatures` for the Example District on its scenario date.
 */

import { type EntityID, UnitStage } from "@mailwoman/dossier"
import {
	type BuildingFeature,
	buildingFeatures,
	BuildingState,
	districtFeatures,
	routeFeatures,
} from "@mailwoman/opportunity-map"
import {
	BUILDING_A,
	BUILDING_B,
	BUILDING_C,
	DISTRICT_SCENARIO,
	SEGMENT_PATHS,
} from "@mailwoman/opportunity-map/example-district"
import type { Page } from "@playwright/test"

import {
	buildingLabels,
	districtDossierOn,
	expect,
	expectRecalculation,
	literalPattern,
	PROSE_LIST,
	recalculate,
	stateWords,
	statusWords,
	test,
	unitsWords,
} from "../e2e/opportunity.ts"

const EXTENT_KIND = "example-district"

function checkbox(page: Page, label: string) {
	return page.getByRole("checkbox", { name: label, exact: true })
}

/**
 * Asserts every building row: the checkbox's name, its checked state, the words of its selection, state
 * and denominator in its accessible description, and the list of source records behind its state.
 */
async function expectBuildingRows(
	page: Page,
	features: readonly BuildingFeature[],
	selected: ReadonlySet<EntityID>
): Promise<void> {
	const list = page.getByRole("list", { name: "Buildings" })

	for (const feature of features) {
		const { building, label, state, units, sources } = feature.properties
		const box = checkbox(page, label)
		const selection = selected.has(building) ? "selected " : ""

		await expect(box).toHaveAccessibleDescription(
			new RegExp(`^${selection}${literalPattern(stateWords(state))} ${literalPattern(unitsWords(units))}$`, "u")
		)

		await (selected.has(building) ? expect(box).toBeChecked() : expect(box).not.toBeChecked())

		if (state === BuildingState.UnknownCoverage || state === BuildingState.UnknownUnitCount) {
			await expect(box).toHaveAccessibleDescription(/\bunknown\b/u)
		}

		const sourceList = page.getByRole("list", { name: `Sources behind the state of ${label}` }).getByRole("listitem")
		const noSource = list.getByText(`No source record stands behind the state of ${label}.`, { exact: true })

		await (sources.length ? expect(sourceList).toHaveText([...sources]) : expect(noSource).toBeVisible())
	}

	// A search of the page text finds the word once for each selected building.
	await expect(list.getByText("selected", { exact: true })).toHaveCount(selected.size)
}

test("the keyboard alone selects and clears buildings, and words identify each state, selection, source and segment", async ({
	page,
}) => {
	const dossier = districtDossierOn(DISTRICT_SCENARIO.asOf)
	const labels = buildingLabels(dossier)
	const features = buildingFeatures(dossier, { unitStage: UnitStage.Completed }).features
	const label = (building: EntityID) => labels.get(building)!

	await page.goto("/")
	await expect(page.getByRole("list", { name: "Buildings" }).getByRole("checkbox")).toHaveCount(features.length)
	await expectBuildingRows(page, features, new Set())

	// The scale control holds the first tab stop, and the building list follows it.
	await page.keyboard.press("Tab")
	await expect(page.getByRole("radio", { name: "Buildings" })).toBeFocused()

	const selected: EntityID[] = []

	for (const building of [BUILDING_A, BUILDING_B, BUILDING_C]) {
		await page.keyboard.press("Tab")
		await expect(checkbox(page, label(building))).toBeFocused()
		await page.keyboard.press("Space")
		selected.push(building)

		await expect(checkbox(page, label(building))).toBeChecked()
		await expect(page.getByRole("status")).toHaveText(statusWords(recalculate(dossier, DISTRICT_SCENARIO, selected)))
	}

	await expectBuildingRows(page, features, new Set(selected))
	await expectRecalculation(page, recalculate(dossier, DISTRICT_SCENARIO, selected), DISTRICT_SCENARIO, labels)

	// Each segment states its status, whether it is shared and the basis that makes it verified or proposed.
	const routes = routeFeatures(dossier, DISTRICT_SCENARIO, SEGMENT_PATHS, selected).features
	const segments = page.getByRole("list", { name: "Route segments" }).getByRole("listitem")

	await expect(segments).toHaveCount(routes.length)

	for (const [index, route] of routes.entries()) {
		const { segment, status, shared, basis } = route.properties
		const item = segments.nth(index)

		await expect(item).toContainText(
			`${segment}: ${status === "verified" ? "verified existing segment" : "proposed construction"}${shared ? ", shared" : ""}.`
		)

		await expect(item).toContainText(
			basis.kind === "source_record"
				? `Basis: source record ${basis.source}.`
				: `Basis: operator assumption stated by ${basis.statedBy}.`
		)

		if (!shared) {
			await expect(item).not.toContainText("shared")
		}

		await expect(item).toContainText("synthetic")
	}

	// The legend names each shape in words.
	await expect(page.getByRole("list", { name: "Legend" }).getByRole("listitem")).toContainText([
		...Object.values(BuildingState).map((state) => stateWords(state)),
		"selected",
		"verified existing segment",
		"proposed construction",
		"shared segment",
		"synthetic",
	])

	// Shift+Tab moves from Example Building C back to Example Building B, and Space clears it.
	await page.keyboard.press("Shift+Tab")
	await expect(checkbox(page, label(BUILDING_B))).toBeFocused()
	await page.keyboard.press("Space")
	await expect(checkbox(page, label(BUILDING_B))).not.toBeChecked()

	const remaining = selected.filter((building) => building !== BUILDING_B)

	await expect(page.getByRole("status")).toHaveText(statusWords(recalculate(dossier, DISTRICT_SCENARIO, remaining)))
	await expectBuildingRows(page, features, new Set(remaining))

	// Tab passes the rows after Example Building B and reaches the clear button, and Enter clears the selection.
	const after = features.findIndex((feature) => feature.properties.building === BUILDING_B)

	for (let step = after + 1; step <= features.length; step += 1) {
		await page.keyboard.press("Tab")
	}

	await expect(page.getByRole("button", { name: "Clear selection" })).toBeFocused()
	await page.keyboard.press("Enter")
	await expect(page.getByRole("status")).toHaveText("No building is selected.")
	await expectBuildingRows(page, features, new Set())

	// Shift+Tab passes every row back to the scale control, and an arrow key switches it to the district scale.
	for (let step = 0; step <= features.length; step += 1) {
		await page.keyboard.press("Shift+Tab")
	}

	await expect(page.getByRole("radio", { name: "Buildings" })).toBeFocused()
	await page.keyboard.press("ArrowRight")
	await expect(page.getByRole("radio", { name: "Districts" })).toBeChecked()

	const districts = page.getByRole("table", { name: `Districts by ${EXTENT_KIND}` })
	const collection = districtFeatures(dossier, { unitStage: UnitStage.Completed, extentKind: EXTENT_KIND })

	await expect(districts.getByRole("row").filter({ has: page.getByRole("rowheader") })).toHaveCount(
		collection.features.length
	)

	for (const district of collection.features) {
		const { buildings, units, states } = district.properties
		const row = districts.getByRole("row").filter({ hasText: PROSE_LIST.format(buildings.map(label)) })
		const counted = Object.values(BuildingState).filter((state) => states[state] > 0)

		await expect(row.getByRole("cell")).toHaveText([
			PROSE_LIST.format(buildings.map(label)),
			String(units.resolved),
			String(units.unresolvedBuildings),
			PROSE_LIST.format(counted.map((state) => `${states[state]} ${stateWords(state)}`)),
		])
	}
})
