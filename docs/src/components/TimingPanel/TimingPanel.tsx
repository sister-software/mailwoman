import type { StageTiming } from "../../shared/resources.tsx"

import styles from "./styles.module.css"

export interface TimingPanelProps {
	timing: StageTiming
}

const STAGES: Array<{ key: keyof StageTiming; label: string; cls: string }> = [
	{ key: "shape", label: "shape + kind", cls: styles.shape },
	{ key: "classify", label: "classify", cls: styles.classify },
	{ key: "resolve", label: "resolve", cls: styles.resolve },
]

function fmt(ms: number): string {
	return ms >= 100 ? `${Math.round(ms)} ms` : `${ms.toFixed(1)} ms`
}

/**
 * Per-stage timing breakdown for a parse — a stacked bar (shape+kind / classify / resolve) sized by
 * each stage's wall-clock, with a small legend showing the split in ms. Companion to the
 * FailureDiagnostic: turns the demo into a teaching tool (you see the model inference dominate) and
 * surfaces perf regressions at a glance. The DB-load cost is deliberately excluded — only the
 * per-parse cascade is timed.
 */
export const TimingPanel: React.FC<TimingPanelProps> = ({ timing }) => {
	const present = STAGES.filter((s) => typeof timing[s.key] === "number") as Array<(typeof STAGES)[number]>
	const total = present.reduce((sum, s) => sum + (timing[s.key] as number), 0)
	if (total <= 0) return null

	return (
		<div className={styles.timingPanel}>
			<div className={styles.heading}>
				Timing <span className={styles.total}>{fmt(total)} total</span>
			</div>
			<div className={styles.bar}>
				{present.map((s) => {
					const ms = timing[s.key] as number
					const pct = (ms / total) * 100
					// Floor the rendered width so a sub-millisecond stage stays visible as a sliver.
					return (
						<div
							key={s.key}
							className={`${styles.seg} ${s.cls}`}
							style={{ width: `${Math.max(pct, 1.5)}%` }}
							title={`${s.label}: ${fmt(ms)}`}
						/>
					)
				})}
			</div>
			<div className={styles.legend}>
				{present.map((s) => (
					<span key={s.key} className={styles.legendItem}>
						<span className={`${styles.swatch} ${s.cls}`} />
						{s.label} <span className={styles.legendMs}>{fmt(timing[s.key] as number)}</span>
					</span>
				))}
			</div>
		</div>
	)
}
