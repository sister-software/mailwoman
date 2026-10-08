/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Everything the page shows for one set of control values and one selection, computed by the model. The
 *   collections come from `buildingFeatures`, `districtFeatures` and `routeFeatures`, the figures from
 *   `selectionEconomics`, and the report text from `reportLines` and `renderScenarioReport`. Every figure on the
 *   page is one of those functions' values, and this module adds, averages and estimates no figure of its own.
 *
 *   A model function that refuses its input throws. The view keeps that refusal as the error's name and message,
 *   and the page shows the message in place of what the function would have returned. A selection holds the
 *   selected buildings in the dossier's building order, so a figure never depends on the order of the clicks.
 */

import { type Dossier, type DossierRecords, type EntityID, reportLines } from "@mailwoman/dossier"
import {
	type BuildingCollection,
	buildingFeatures,
	type DistrictCollection,
	districtFeatures,
	type RouteCollection,
	routeFeatures,
	type SegmentPath,
	selectionEconomics,
	type SelectionEconomics,
} from "@mailwoman/opportunity-map"
import { DISTRICT_RECORDS, DISTRICT_SCENARIO, SEGMENT_PATHS } from "@mailwoman/opportunity-map/example-district"
import { renderScenarioReport, type Scenario, scenarioReport } from "@mailwoman/route-scenarios"

import { type ControlValues, dossierFor, type InputRow, inputRows, scenarioFor } from "#controls"
import { buildingReportPart, REPORT_OPTIONS } from "#evidence"

/**
 * The records, scenario and segment paths the application draws, and the extent
 * kind its districts cluster by.
 */
export interface Dataset {
	records: DossierRecords
	scenario: Scenario
	paths: readonly SegmentPath[]
	extentKind: string
}

/**
 * The synthetic Example District from `@mailwoman/opportunity-map`,
 * clustered by its `example-district` extents.
 */
export const EXAMPLE_DISTRICT: Dataset = {
	records: DISTRICT_RECORDS,
	scenario: DISTRICT_SCENARIO,
	paths: SEGMENT_PATHS,
	extentKind: "example-district",
}

/**
 * The result of a model function: its value, its refusal, or no call because no building is selected.
 */
export type Result<T> =
	| { status: "computed"; value: T }
	| { status: "refused"; name: string; message: string }
	| { status: "empty" }

function result<T>(compute: () => T): Result<T> {
	try {
		return { status: "computed", value: compute() }
	} catch (error) {
		if (!(error instanceof Error)) throw error

		return { status: "refused", name: error.name, message: error.message }
	}
}

export interface OpportunityView {
	dossier: Dossier
	scenario: Scenario
	/**
	 * The selected buildings in the dossier's building order.
	 */
	selection: readonly EntityID[]
	labels: ReadonlyMap<EntityID, string>
	buildings: BuildingCollection
	districts: DistrictCollection
	routes: Result<RouteCollection>
	economics: Result<SelectionEconomics>
	/**
	 * The cost and value report that `renderScenarioReport` writes for the selection.
	 */
	costAndValue: Result<string>
	/**
	 * Each building's part of the dossier report: the text of its `reportLines` records.
	 */
	dossierParts: ReadonlyMap<EntityID, string>
	inputs: readonly InputRow[]
}

/**
 * The view of `dataset` for the control values and the selected buildings.
 */
export function opportunityView(
	dataset: Dataset,
	values: ControlValues,
	selected: ReadonlySet<EntityID>
): OpportunityView {
	const dossier = dossierFor(dataset.records, values)
	const scenario = scenarioFor(dataset.scenario, values)
	const buildings = dossier.buildings.map((section) => section.building)
	const selection = buildings.map((building) => building.id).filter((building) => selected.has(building))

	const forSelection = <T>(compute: () => T): Result<T> => (selection.length ? result(compute) : { status: "empty" })
	const lines = reportLines(dossier)

	return {
		dossier,
		scenario,
		selection,
		labels: new Map(buildings.map((building) => [building.id, building.label])),
		buildings: buildingFeatures(dossier, { unitStage: values.unitStage }),
		districts: districtFeatures(dossier, { unitStage: values.unitStage, extentKind: dataset.extentKind }),
		routes: forSelection(() => routeFeatures(dossier, scenario, dataset.paths, selection)),
		economics: forSelection(() => selectionEconomics(dossier, scenario, selection)),
		costAndValue: forSelection(() =>
			renderScenarioReport(scenarioReport(dossier, { ...scenario, selected: selection }, REPORT_OPTIONS))
		),
		dossierParts: new Map(buildings.map((building) => [building.id, buildingReportPart(lines, building.id)])),
		inputs: inputRows(dataset.scenario, scenario, dossier, dataset.records),
	}
}
