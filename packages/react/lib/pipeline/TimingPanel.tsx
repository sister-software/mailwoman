/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `TimingPanel` — the per-stage timing breakdown: a stacked bar sized by each stage's wall-clock, plus a legend.
 *   Stage colours are distinct hues, never the confidence red/amber/green, because they encode the pipeline stage and
 *   not quality.
 */

import type { StageTiming } from "@mailwoman/core/pipeline/client-result"
import type { ReactNode } from "react"

export interface TimingPanelProps {
	timing: StageTiming
}

const STAGES: ReadonlyArray<{ key: keyof StageTiming; label: string }> = [
	{ key: "shape", label: "shape + kind" },
	{ key: "classify", label: "classify" },
	{ key: "resolve", label: "resolve" },
]

function formatMilliseconds(ms: number): string {
	return ms >= 100 ? `${Math.round(ms)} ms` : `${ms.toFixed(1)} ms`
}

export function TimingPanel({ timing }: TimingPanelProps): ReactNode {
	const present = STAGES.flatMap((stage) => {
		const ms = timing[stage.key]

		return typeof ms === "number" ? [{ ...stage, ms }] : []
	})

	const total = present.reduce((sum, stage) => sum + stage.ms, 0)

	if (total <= 0) return null

	return (
		<div className="mw-timing">
			<div className="mw-timing__heading">
				Timing <span className="mw-timing__total">{formatMilliseconds(total)} total</span>
			</div>
			<div className="mw-timing__bar">
				{present.map((stage) => (
					// The rendered width is floored so a sub-millisecond stage stays visible as a sliver.
					<div
						key={stage.key}
						className={`mw-timing__seg mw-timing__seg--${stage.key}`}
						style={{ width: `${Math.max((stage.ms / total) * 100, 1.5)}%` }}
						title={`${stage.label}: ${formatMilliseconds(stage.ms)}`}
					/>
				))}
			</div>
			<div className="mw-timing__legend">
				{present.map((stage) => (
					<span key={stage.key} className="mw-timing__item">
						<span className={`mw-timing__swatch mw-timing__seg--${stage.key}`} />
						{stage.label} <span className="mw-timing__ms">{formatMilliseconds(stage.ms)}</span>
					</span>
				))}
			</div>
		</div>
	)
}
