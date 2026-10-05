/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The evidence a selection links to: each selected building's part of the dossier report, and the cost and value
 *   report that `@mailwoman/route-scenarios` writes for the selection.
 *
 *   `renderReport` heads each building's part with `## <label>` and ends it where the next level-two heading
 *   starts, so a part is the text from its heading to that next heading. A label that heads no part, or heads two,
 *   throws rather than returning a part that belongs to another building.
 */

import type { EntityID } from "@mailwoman/dossier"
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
 * Each building's part of a `renderReport` text, by building identifier.
 */
export function dossierReportParts(
	report: string,
	buildings: readonly { id: EntityID; label: string }[]
): ReadonlyMap<EntityID, string> {
	const parts = new Map<EntityID, string>()

	for (const building of buildings) {
		const heading = `\n## ${building.label}\n`
		const start = report.indexOf(heading)

		if (start === -1) throw new Error(`the dossier report has no part headed "## ${building.label}"`)

		if (report.includes(heading, start + 1)) {
			throw new Error(`the dossier report heads two parts "## ${building.label}", so neither belongs to one building`)
		}

		const end = report.indexOf("\n## ", start + heading.length - 1)

		parts.set(building.id, report.slice(start + 1, end === -1 ? undefined : end).trimEnd())
	}

	return parts
}
