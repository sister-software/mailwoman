// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The support matrix, rendered from the declaration in `@mailwoman/codex/support`.
 *
 *   Edit `packages/codex/lib/support/promises.json` rather than this component.
 */

import { SUPPORT_PROMISES, type SupportDepth } from "@mailwoman/codex/support"
import React from "react"

const DEPTH_LABELS: Record<SupportDepth, string> = {
	"address-point": "Address point",
	street: "Street",
	postcode: "Postcode",
	locality: "City or town",
	region: "Region",
	country: "Country",
}

const regions = new Intl.DisplayNames(["en"], { type: "region" })
const languages = new Intl.DisplayNames(["en"], { type: "language" })
const scripts = new Intl.DisplayNames(["en"], { type: "script" })

function describeInput(tag: string): string {
	const [language, script] = tag.split("-")

	if (!language || !script) return tag

	return `${languages.of(language) ?? language} in ${scripts.of(script) ?? script} script`
}

/**
 * One row per support promise: the country, the input it covers, and the deepest component it guarantees.
 */
export default function SupportMatrix(): React.ReactElement {
	const rows = SUPPORT_PROMISES.toSorted(
		(left, right) => left.country.localeCompare(right.country) || left.input.localeCompare(right.input)
	)

	return (
		<table>
			<thead>
				<tr>
					<th>Address in</th>
					<th>Typed as</th>
					<th>Guaranteed to</th>
					<th>Names in other scripts</th>
				</tr>
			</thead>
			<tbody>
				{rows.map((promise) => (
					<tr key={`${promise.country}-${promise.input}`}>
						<td>
							{regions.of(promise.country) ?? promise.country} (<code>{promise.country}</code>)
						</td>
						<td>
							{describeInput(promise.input)} (<code>{promise.input}</code>)
						</td>
						<td>{DEPTH_LABELS[promise.depth]}</td>
						<td>
							{promise.embeddedNameScripts.length
								? promise.embeddedNameScripts.map((script) => scripts.of(script) ?? script).join(", ")
								: "None declared"}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	)
}
