import { KindResult } from "../../shared/resources.tsx"

import styles from "./styles.module.css"

export interface KindBadgeProps {
	kindResult: KindResult
}

/**
 * Compact display of the Stage 2.5 kind classifier's verdict. Shows the top kind + confidence as a
 * pill; expands to show alternatives on hover/click. Helps users see the staged pipeline working —
 * bare postcodes appear as `postcode_only`, single-word inputs as `locality_only`, multi-segment
 * inputs as `structured_address`, etc.
 */
export const KindBadge: React.FC<KindBadgeProps> = ({ kindResult }) => {
	const pct = (n: number) => `${Math.round(n * 100)}%`
	return (
		<details className={styles.kindBadge ?? ""} style={{ marginBottom: "0.5rem", fontSize: "0.9rem" }}>
			<summary style={{ cursor: "pointer", userSelect: "none" }}>
				<strong>Kind:</strong> <code>{kindResult.kind}</code>{" "}
				<span style={{ opacity: 0.7 }}>({pct(kindResult.confidence)})</span>
			</summary>
			{kindResult.alternatives.length > 0 ? (
				<ul style={{ margin: "0.25rem 0 0 1rem", padding: 0, listStyle: "disc" }}>
					{kindResult.alternatives.map((alt, i) => (
						<li key={i}>
							<code>{alt.kind}</code> <span style={{ opacity: 0.7 }}>({pct(alt.confidence)})</span>
						</li>
					))}
				</ul>
			) : null}
		</details>
	)
}
