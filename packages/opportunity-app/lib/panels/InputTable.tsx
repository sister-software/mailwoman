/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The inputs the controls set, each with its value in the applied scenario and its basis. The cost and value
 *   report lists every other rate, quantity and operating assumption with its basis.
 */

import type { ReactNode } from "react"

import type { InputRow } from "#controls"

export function InputTable({ inputs }: { inputs: readonly InputRow[] }): ReactNode {
	return (
		<section className="panel" aria-labelledby="inputs-heading">
			<h2 id="inputs-heading">Scenario inputs</h2>
			<div className="table-scroll">
				<table className="data-table">
					<caption>Scenario inputs and their bases</caption>
					<thead>
						<tr>
							<th scope="col">Input</th>
							<th scope="col">Value</th>
							<th scope="col">Basis</th>
						</tr>
					</thead>
					<tbody>
						{inputs.map((row) => (
							<tr key={row.input}>
								<th scope="row">{row.input}</th>
								<td>{row.value}</td>
								<td>{row.basis}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	)
}
