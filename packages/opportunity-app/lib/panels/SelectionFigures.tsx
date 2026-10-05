/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The figures of the selection, as `selectionEconomics` returns them, each beside its origin. Every economic
 *   figure carries the word synthetic when the scenario's inputs are synthetic. When the model refuses the
 *   selection, its message stands in place of the figures, and no figure is shown. The status line is a live region
 *   that announces the recalculated figures after each change, and the links lead to the selection's evidence.
 */

import { type EntityID, proseList } from "@mailwoman/dossier"
import type { SelectionEconomics } from "@mailwoman/opportunity-map"
import { formatMoney, type Scenario } from "@mailwoman/route-scenarios"
import type { ReactNode } from "react"

import { COST_AND_VALUE_ANCHOR, dossierAnchor } from "#evidence"
import type { Outcome } from "#view"
import { monthText, originText, recalculationText } from "#words"

export interface SelectionFiguresProps {
	economics: Outcome<SelectionEconomics>
	scenario: Scenario
	selection: readonly EntityID[]
	labels: ReadonlyMap<EntityID, string>
}

interface Figure {
	name: string
	value: string
	origin: string
}

function figuresOf(
	economics: SelectionEconomics,
	scenario: Scenario,
	labels: ReadonlyMap<EntityID, string>
): readonly Figure[] {
	const origin = originText(economics.synthetic)
	const money = (amount: number): string => formatMoney(amount, economics.currency)

	const named = (buildings: readonly EntityID[]): string =>
		proseList(buildings.map((building) => labels.get(building) ?? building))

	const peak = economics.peakFunding

	const figure = (name: string, value: string): Figure => ({ name, value, origin })

	return [
		{ name: "Selected buildings", value: named(economics.selection), origin: "selection" },
		{ name: "Eligible units", value: String(economics.units), origin: "dossier unit totals" },
		figure("Route construction cost", money(economics.construction.route)),
		figure("Project costs", money(economics.construction.project)),
		figure("Common cost", money(economics.construction.common)),
		figure("Direct cost", money(economics.construction.direct)),
		figure("Total construction cost", money(economics.construction.total)),
		...economics.segments.map((entry) =>
			figure(`Segment ${entry.segment}`, `${money(entry.amount)}, used by ${named(entry.usedBy)}`)
		),
		figure("Net present value", money(economics.npv)),
		figure("First revenue", monthText(scenario.monthZero, economics.firstRevenueMonth)),
		figure("Cash before first revenue", money(economics.cashBeforeFirstRevenue)),
		figure(
			"Peak funding",
			peak.month === null
				? "none: the cumulative cash flow stays at or above zero"
				: `${money(peak.amount)} in ${monthText(scenario.monthZero, peak.month)}`
		),
	]
}

export function SelectionFigures({ economics, scenario, selection, labels }: SelectionFiguresProps): ReactNode {
	return (
		<section className="panel panel--figures" aria-labelledby="economics-heading">
			<h2 id="economics-heading">Selection economics</h2>
			<p role="status" className="status-line">
				{recalculationText(economics)}
			</p>

			{economics.status === "empty" ? (
				<p className="panel__note">Select a building to compute the selection's figures.</p>
			) : null}

			{economics.status === "refused" ? (
				<>
					<p className="panel__note">The model computed no figures for this selection. Its message:</p>
					<p className="refusal">{economics.message}</p>
				</>
			) : null}

			{economics.status === "computed" ? (
				<div className="table-scroll">
					<table className="data-table">
						<caption>Figures for the selection</caption>
						<thead>
							<tr>
								<th scope="col">Figure</th>
								<th scope="col">Value</th>
								<th scope="col">Origin</th>
							</tr>
						</thead>
						<tbody>
							{figuresOf(economics.value, scenario, labels).map((entry) => (
								<tr key={entry.name}>
									<th scope="row">{entry.name}</th>
									<td className="number">{entry.value}</td>
									<td>
										<span className={`origin origin--${entry.origin === "synthetic" ? "synthetic" : "record"}`}>
											{entry.origin}
										</span>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : null}

			{selection.length ? (
				<nav className="evidence-links" aria-label="Evidence for the selection">
					<ul>
						{selection.map((building) => (
							<li key={building}>
								<a href={`#${dossierAnchor(building)}`}>Dossier part: {labels.get(building) ?? building}</a>
							</li>
						))}
						<li>
							<a href={`#${COST_AND_VALUE_ANCHOR}`}>Cost and value report for the selection</a>
						</li>
					</ul>
				</nav>
			) : null}
		</section>
	)
}
