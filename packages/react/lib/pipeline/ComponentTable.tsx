// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `ComponentTable` — the tag / value / confidence table of decoded components. Presentational.
 */

import type { ParsedComponent } from "@mailwoman/core/pipeline/client-result"
import type { ReactNode } from "react"

import { ConfidenceCell } from "./ConfidenceCell.tsx"

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
