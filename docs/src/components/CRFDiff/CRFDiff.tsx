/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   CRFDiff — static side-by-side argmax vs. Viterbi decode comparison.
 *
 *   Demonstrates why per-token argmax fails on multi-word named entities (the "Saint Petersburg"
 *   problem) and how linear-chain CRF Viterbi decode fixes it by considering transition scores
 *   between labels.
 *
 *   Reuses BIOHighlight's colour scheme:
 *
 *   - B-X green (beginning of a component span)
 *   - I-X blue (inside a component span)
 *   - O gray (outside any component span)
 *
 *   The component is intentionally static — it hard-codes the Saint Petersburg example rather than
 *   accepting dynamic data. Use it in MDX docs to explain the argmax → Viterbi upgrade.
 */

import styles from "./styles.module.css"

/**
 * Hard-coded transition matrix for the Saint Petersburg example.
 *
 * Three labels: B-locality, I-locality, O.
 *
 * From → to B-locality I-locality O ────────────────────────────────────────── B-locality -2.0 +1.5 0 I-locality -1.0
 * +2.0 0 O +0.5 -∞ +1.0
 *
 * ILLUSTRATIVE, not shipped: the soft scores (+1.5, +2.0, …) show what a learned transition matrix would look like.
 * Mailwoman's shipped decoder uses only the structural BIO mask (0 for valid transitions, −∞ for invalid) — no learned
 * transition scores train or ship (first CE-only at v0.5.0, permanent from v0.6.3 on; see
 * docs/articles/concepts/crf-decoder.mdx). The −∞ row is the part that matches production.
 *
 * Key insight:
 *
 * - B-locality → I-locality (+1.5) is strongly preferred over B-locality → B-locality (-2.0), so Viterbi chains "Saint"
 *   and "Petersburg" into a single span (B → I).
 * - O → I-locality (-∞) is structurally forbidden — an I-X label can never follow an O label, preventing orphan-I bugs.
 * - I-locality → I-locality (+2.0) encourages multi-token continuations.
 */
const TRANSITION_MATRIX: Array<{
	from: string
	toB: { score: string; class: string }
	toI: { score: string; class: string }
	toO: { score: string; class: string }
}> = [
	{
		from: "B-locality",
		toB: { score: "−2.0", class: styles.allowed },
		toI: { score: "+1.5", class: styles.preferred },
		toO: { score: "0", class: styles.allowed },
	},
	{
		from: "I-locality",
		toB: { score: "−1.0", class: styles.allowed },
		toI: { score: "+2.0", class: styles.preferred },
		toO: { score: "0", class: styles.allowed },
	},
	{
		from: "O",
		toB: { score: "+0.5", class: styles.allowed },
		toI: { score: "−∞", class: styles.forbidden },
		toO: { score: "+1.0", class: styles.preferred },
	},
]

/**
 * Render the argmax-vs-Viterbi comparison for the Saint Petersburg example.
 *
 * Emits three sections:
 *
 * 1. Argmax decode — per-token independence produces B-B (invalid).
 * 2. Viterbi decode — global sequence produces B-I (correct).
 * 3. Transition matrix — the scores that make Viterbi win.
 */
export const CRFDiff: React.FC = () => {
	return (
		<div className={styles.crfDiff}>
			{/* Legend */}
			<div className={styles.legend}>
				<span className={`${styles.dot} ${styles.b}`} /> B-X (begin)
				<span className={`${styles.dot} ${styles.i}`} /> I-X (inside)
				<span className={`${styles.dot} ${styles.o}`} /> O (outside)
			</div>

			{/* Argmax decode (incorrect) */}
			<div className={styles.decodeSection}>
				<div className={styles.decodeLabel}>
					Argmax <span style={{ fontWeight: 400, fontSize: "0.75rem" }}>(per-token independence)</span>
				</div>
				<div className={styles.track}>
					<span className={styles.wordCol} title="B-locality">
						<span className={`${styles.word} ${styles.bioB}`}>Saint</span>
						<span className={styles.label}>B-locality</span>
					</span>
					<span className={styles.wordCol} title="B-locality — invalid duplicate B-">
						<span className={`${styles.word} ${styles.bioB} ${styles.invalid}`}>Petersburg</span>
						<span className={styles.label}>B-locality ❌</span>
					</span>
				</div>
				<div className={`${styles.note} ${styles.noteInvalid}`}>
					Two B- tags in a row — the parser sees two separate spans instead of one multi-word locality.
				</div>
			</div>

			{/* Viterbi decode (correct) */}
			<div className={styles.decodeSection}>
				<div className={styles.decodeLabel}>
					Viterbi <span style={{ fontWeight: 400, fontSize: "0.75rem" }}>(global sequence)</span>
				</div>
				<div className={styles.track}>
					<span className={styles.wordCol} title="B-locality">
						<span className={`${styles.word} ${styles.bioB}`}>Saint</span>
						<span className={styles.label}>B-locality</span>
					</span>
					<span className={styles.wordCol} title="I-locality — valid continuation">
						<span className={`${styles.word} ${styles.bioI}`}>Petersburg</span>
						<span className={styles.label}>I-locality</span>
					</span>
				</div>
				<div className={`${styles.note} ${styles.noteValid}`}>
					B- → I- transition — the parser recognises one continuous locality span.
				</div>
			</div>

			{/* Transition matrix */}
			<div className={styles.matrixSection}>
				<div className={styles.decodeLabel}>
					Transition scores{" "}
					<span style={{ fontWeight: 400, fontSize: "0.75rem" }}>
						(additive log-prob — illustrative: what a learned transition matrix would look like, not what ships)
					</span>
				</div>
				<table className={styles.matrix}>
					<thead>
						<tr>
							<th>from → to</th>
							<th>B-locality</th>
							<th>I-locality</th>
							<th>O</th>
						</tr>
					</thead>
					<tbody>
						{TRANSITION_MATRIX.map((row) => (
							<tr key={row.from}>
								<td>{row.from}</td>
								<td className={row.toB.class}>{row.toB.score}</td>
								<td className={row.toI.class}>{row.toI.score}</td>
								<td className={row.toO.class}>{row.toO.score}</td>
							</tr>
						))}
					</tbody>
				</table>
				<div className={`${styles.note}`} style={{ marginTop: "0.5rem" }}>
					Green = allowed transition · Blue = strongly preferred · Red = structurally forbidden (−∞). The Viterbi path
					(B → I) scores +1.5; the argmax path (B → B) scores −2.0, so Viterbi wins by 3.5 log-prob. The soft scores are
					hypothetical — Mailwoman's shipped table carries only 0 and −∞.
				</div>
			</div>
		</div>
	)
}
