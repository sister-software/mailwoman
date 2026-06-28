import { ResolvedHit } from "../../shared/resources.tsx"

import styles from "./styles.module.css"

interface CandidatePickerProps {
	candidates: ResolvedHit[]
	selectedIndex: number
	onSelect: (index: number) => void
}

/**
 * Lets the operator see WOF's runner-up hits and switch the rendered marker to any of them. Helpful when the parser
 * found e.g. "Portland" and WOF returned both Portland-OR and Portland-ME with similar scores — picker disambiguates
 * without re-typing the query.
 */
export const CandidatePicker: React.FC<CandidatePickerProps> = ({ candidates, selectedIndex, onSelect }) => {
	return (
		<div className={styles.candidatePicker}>
			<h2>Other candidates ({candidates.length - 1})</h2>
			<ol className={styles.candidateList}>
				{candidates.map((c, i) => (
					<li key={`${c.id}-${i}`}>
						<button
							type="button"
							className={`${styles.candidateBtn} ${i === selectedIndex ? styles.candidateBtnActive : ""}`}
							onClick={() => onSelect(i)}
							title={`${c.placetype} • WOF ${c.id} • score ${c.score.toFixed(3)}`}
						>
							<span className={styles.candidateRank}>#{i + 1}</span>
							<span className={styles.candidateName}>{c.name}</span>
							<span className={styles.candidateMeta}>
								{c.placetype} · {c.score.toFixed(2)}
							</span>
						</button>
					</li>
				))}
			</ol>
		</div>
	)
}
