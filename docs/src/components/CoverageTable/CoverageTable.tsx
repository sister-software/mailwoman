/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What resolves where, by country: the parser claim, the weights overlay, the street data and the finest tier.
 */

import Link from "@docusaurus/Link"
import type { ReactNode } from "react"

import { CoverageRows } from "./coverage.ts"

import styles from "./styles.module.css"

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
					<th scope="col">Parser claim</th>
					<th scope="col">Weights overlay</th>
					<th scope="col">Street data</th>
					<th scope="col">Finest tier</th>
				</tr>
			</thead>
			<tbody>
				{CoverageRows.map((row) => (
					<tr key={row.region}>
						<th scope="row">{row.region}</th>
						<td>{row.parserTier === null ? <Mark on={false} /> : `Tier ${row.parserTier}`}</td>
						<td>
							<Mark on={row.overlay} />
						</td>
						<td>{row.streetBundle ? <code>{row.streetBundle}</code> : <Mark on={false} />}</td>
						<td>
							<span className={row.bestTier === "address point" ? styles.tierFine : styles.tier}>{row.bestTier}</span>
						</td>
					</tr>
				))}
			</tbody>
		</table>
		<p className={styles.fine}>
			A parser claim is a coordinate-graded evaluation; tier 1 can stop a release. The admin tier is a locality or
			region centroid. <Link to="/docs/developers/reference/locales-and-tiers">Locales and tiers</Link> states what each
			tier means and what is queued.
		</p>
	</div>
)
