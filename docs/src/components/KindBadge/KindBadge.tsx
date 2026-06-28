/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { FC } from "react"

import type { KindResult } from "../../shared/resources.tsx"

import styles from "./styles.module.css"

export interface KindBadgeProps {
	kindResult: KindResult
}

const formatPct = (n: number): string => `${Math.round(n * 100)}%`

/**
 * Compact display of the Stage 2.5 kind classifier's verdict. Shows the top kind + confidence as a pill; expands to
 * show alternatives on hover/click. Helps users see the staged pipeline working — bare postcodes appear as
 * `postcode_only`, single-word inputs as `locality_only`, multi-segment inputs as `structured_address`, etc.
 */
export const KindBadge: FC<KindBadgeProps> = ({ kindResult }) => {
	return (
		<details className={styles.kindBadge}>
			<summary className={styles.summary}>
				<strong>Kind:</strong> <code>{kindResult.kind}</code>{" "}
				<span className={styles.confidence}>({formatPct(kindResult.confidence)})</span>
			</summary>
			{kindResult.alternatives.length > 0 ? (
				<ul className={styles.alternatives}>
					{kindResult.alternatives.map((alt) => (
						<li key={alt.kind}>
							<code>{alt.kind}</code> <span className={styles.confidence}>({formatPct(alt.confidence)})</span>
						</li>
					))}
				</ul>
			) : null}
		</details>
	)
}
