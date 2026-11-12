// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `MatchTable` — what the data held for each parsed component.
 *   Presentational.
 */

import { isPresent } from "@mailwoman/core/objects"
import type { ComponentMatch } from "@mailwoman/core/pipeline/client-result"
import type { ReactNode } from "react"

export interface MatchTableProps {
	matches: ComponentMatch[]
}

function describeMatch({ matched, name, placetype, placeID, note }: ComponentMatch): string {
	if (!matched) return note ? `no match: ${note}` : "no match"

	const found = [name, placetype ? `(${placetype})` : null, placeID].filter(isPresent).join(" ")

	return note ? `${found}: ${note}` : found
}

export function MatchTable({ matches }: MatchTableProps): ReactNode {
	return (
		<table className="mw-components">
			<thead>
				<tr>
					<th>tag</th>
					<th>value</th>
					<th>matched</th>
				</tr>
			</thead>
			<tbody>
				{matches.map((match, i) => (
					<tr key={i}>
						<td>{match.tag}</td>
						<td>{match.value}</td>
						<td>{describeMatch(match)}</td>
					</tr>
				))}
			</tbody>
		</table>
	)
}
