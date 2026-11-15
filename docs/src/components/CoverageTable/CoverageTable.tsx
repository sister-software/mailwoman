// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The home page's coverage table: one row per country with a support promise,
 *   read from `@mailwoman/codex/support`.
 *
 *   Edit `packages/codex/lib/support/promises.json` rather than this component.
 */

import Link from "@docusaurus/Link"
import { SUPPORT_DEPTHS, SUPPORT_PROMISES, type SupportDepth, type SupportPromise } from "@mailwoman/codex/support"
import type { ReactNode } from "react"

import styles from "./styles.module.css"

const DEPTH_LABELS: Record<SupportDepth, string> = {
	"address-point": "Rooftop",
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

	return `${languages.of(language) ?? language} (${scripts.of(script) ?? script})`
}

/**
 * The promises grouped by country, in the order of each country's deepest promise, then by country name.
 */
function countryRows(): Array<{ country: string; name: string; promises: SupportPromise[] }> {
	const byCountry = new Map<string, SupportPromise[]>()

	for (const promise of SUPPORT_PROMISES) {
		byCountry.set(promise.country, [...(byCountry.get(promise.country) ?? []), promise])
	}

	const deepest = (promises: readonly SupportPromise[]): number =>
		Math.min(...promises.map((promise) => SUPPORT_DEPTHS.indexOf(promise.depth)))

	return [...byCountry.entries()]
		.map(([country, promises]) => ({ country, name: regions.of(country) ?? country, promises }))
		.toSorted((left, right) => deepest(left.promises) - deepest(right.promises) || left.name.localeCompare(right.name))
}

export const CoverageTable = (): ReactNode => (
	<div className={styles.wrap}>
		<table className={styles.table}>
			<thead>
				<tr>
					<th scope="col">Country</th>
					<th scope="col">Typed in</th>
					<th scope="col">Guaranteed to</th>
				</tr>
			</thead>
			<tbody>
				{countryRows().map((row) =>
					row.promises.map((promise, index) => (
						<tr key={`${row.country}-${promise.input}`}>
							{index === 0 ? (
								<th scope="row" rowSpan={row.promises.length}>
									{row.name}
								</th>
							) : null}
							<td>{describeInput(promise.input)}</td>
							<td>
								<span className={promise.depth === "address-point" ? styles.tierFine : styles.tier}>
									{DEPTH_LABELS[promise.depth]}
								</span>
							</td>
						</tr>
					))
				)}
			</tbody>
		</table>
		<p className={styles.fine}>
			Inside the guaranteed depth, a wrong or missing result is a bug we fix. Below it, deeper components can come back
			unresolved, and other countries and scripts may still parse without a guarantee.{" "}
			<Link to="/docs/reference/support">See every support promise →</Link>
		</p>
	</div>
)
