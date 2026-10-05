/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The district table repeats the district markers of the map. Each row gives the sum of the district's resolved
 *   unit totals and, in its own column, the count of its buildings whose total is unresolved, so an unknown unit
 *   count is never folded into the sum as a zero.
 */

import type { EntityID } from "@mailwoman/dossier"
import type { DistrictCollection } from "@mailwoman/opportunity-map"
import type { ReactNode } from "react"

import { districtHeading, proseList, statesText } from "#words"

export interface DistrictTableProps {
	districts: DistrictCollection
	extentKind: string
	labels: ReadonlyMap<EntityID, string>
}

export function DistrictTable({ districts, extentKind, labels }: DistrictTableProps): ReactNode {
	const stage = districts.features[0]?.properties.units.stage

	return (
		<section className="panel" aria-labelledby="districts-heading">
			<h2 id="districts-heading">Districts</h2>
			<div className="table-scroll">
				<table className="data-table">
					<caption>
						Districts by {extentKind}
						{stage ? `, ${stage} units` : ""}
					</caption>
					<thead>
						<tr>
							<th scope="col">District</th>
							<th scope="col">Buildings</th>
							<th scope="col">Resolved units</th>
							<th scope="col">Buildings with an unresolved total</th>
							<th scope="col">Buildings by state</th>
						</tr>
					</thead>
					<tbody>
						{districts.features.map(({ properties }) => (
							<tr key={districtHeading(properties)}>
								<th scope="row">{districtHeading(properties)}</th>
								<td>{proseList(properties.buildings.map((building) => labels.get(building) ?? building))}</td>
								<td className="number">{properties.units.resolved}</td>
								<td className="number">{properties.units.unresolvedBuildings}</td>
								<td>{statesText(properties.states)}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	)
}
