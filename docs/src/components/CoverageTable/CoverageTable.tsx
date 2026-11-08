// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Shows parsing evaluations, available models and location detail by country.
 */

import Link from "@docusaurus/Link"
import type { ReactNode } from "react"

import { CoverageRows } from "./coverage.ts"

import styles from "./styles.module.css"

/**
 * The evaluation tiers in the locales reference use these descriptions on the homepage.
 */
const PARSING_TEST_LABELS: Readonly<Record<number, string>> = {
	1: "Country + real-world tests",
	2: "Country test set",
	3: "Limited tests",
}

const Mark = ({ on }: { on: boolean }): ReactNode =>
	on ? (
		<span className={styles.yes} aria-label="Yes">
			✓
		</span>
	) : (
		<span className={styles.no} aria-label="No">
			—
		</span>
	)

export const CoverageTable = (): ReactNode => (
	<div className={styles.wrap}>
		<table className={styles.table}>
			<thead>
				<tr>
					<th scope="col">Country or region</th>
					<th scope="col">Parsing tests</th>
					<th scope="col">Local parsing data</th>
					<th scope="col">Street data</th>
					<th scope="col">Location detail</th>
				</tr>
			</thead>
			<tbody>
				{CoverageRows.map((row) => (
					<tr key={row.region}>
						<th scope="row">{row.region}</th>
						<td>
							{row.parserTier != null ? (PARSING_TEST_LABELS[row.parserTier] ?? "Not yet rated") : "Not yet rated"}
						</td>
						<td>
							<Mark on={row.overlay} />
						</td>
						<td>{row.streetBundle ? <code>{row.streetBundle}</code> : <Mark on={false} />}</td>
						<td>
							<span className={row.bestTier === "address point" ? styles.tierFine : styles.tier}>
								{row.bestTier === "address point"
									? "Rooftop"
									: row.bestTier === "admin"
										? "City or region"
										: row.bestTier}
							</span>
						</td>
					</tr>
				))}
			</tbody>
		</table>
		<p className={styles.fine}>
			Parsing tests measure how well Mailwoman reads address text. Local parsing data adds country-specific address
			knowledge. City or region results mark the center of an area; rooftop results identify individual addresses where
			the data includes them. Japan supports postcode lookup without a published parsing rating.{" "}
			<Link to="/docs/developers/reference/locales-and-tiers">See evaluation methods and download options →</Link>
		</p>
	</div>
)
