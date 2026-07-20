/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `ComponentTable` — the tag / value / confidence table of decoded components. Presentational.
 */

import type { ReactNode } from "react"

import { ConfidenceCell } from "./ConfidenceCell.tsx"
import type { ParsedComponent } from "./types.ts"

export interface ComponentTableProps {
	nodes: ParsedComponent[]
}

export function ComponentTable({ nodes }: ComponentTableProps): ReactNode {
	return (
		<table className="mw-components">
			<thead>
				<tr>
					<th>tag</th>
					<th>value</th>
					<th>confidence</th>
				</tr>
			</thead>
			<tbody>
				{nodes.map((node, i) => (
					<tr key={i}>
						<td>{node.tag}</td>
						<td>{String(node.value ?? "")}</td>
						<td>
							<ConfidenceCell confidence={node.confidence} />
						</td>
					</tr>
				))}
			</tbody>
		</table>
	)
}
