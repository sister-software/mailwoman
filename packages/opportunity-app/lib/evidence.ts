/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The evidence a selection links to: each selected building's part of the dossier report, and the cost and value
 *   report that `@mailwoman/route-scenarios` writes for the selection.
 *
 *   `reportLines` returns the dossier report as line records, and each line of a building's section names that
 *   building. A building's part is the text of exactly those records, in the report's order, so the part shows
 *   each of the building's lines once and holds no line of another building.
 */

import type { EntityID, ReportLine } from "@mailwoman/dossier"
import { CostCategory, noBuildCase, type ScenarioReportOptions } from "@mailwoman/route-scenarios"

/**
 * The page anchor of the cost and value report.
 */
export const COST_AND_VALUE_ANCHOR = "cost-and-value"

/**
 * The page anchor of a building's dossier part, such as `dossier-building-example-a`.
 */
export function dossierAnchor(building: EntityID): string {
	return `dossier-${building.replaceAll(/[^a-z0-9]+/giu, "-")}`
}

/**
 * The options of the cost and value report, stated by this application.
 *
 * The capex range's low and high cases and the no-build comparison case are scenarios over synthetic
 * inputs, and the report states that its inputs are synthetic when the scenario's origin is synthetic.
 */
export const REPORT_OPTIONS: ScenarioReportOptions = {
	capexRange: {
		low: {
			label: "every construction line 10% under the rate card",
			basisPoints: -1000,
			categories: Object.values(CostCategory),
		},
		high: {
			label: "outside plant 25% over the rate card",
			basisPoints: 2500,
			categories: [CostCategory.OutsidePlant],
		},
	},
	cases: [noBuildCase()],
}

/**
 * A building's part of the dossier report: the text of the line records whose
 * `building` is the building, in order, one record per line.
 */
export function buildingReportPart(lines: readonly ReportLine[], building: EntityID): string {
	return lines
		.filter((entry) => entry.building === building)
		.map((entry) => entry.text)
		.join("\n")
}
