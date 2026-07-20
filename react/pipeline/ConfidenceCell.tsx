/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `ConfidenceCell` — a compact confidence bar + value for the component table. Tiers the fill colour
 *   at 0.8 / 0.5. Presentational.
 */

import { cx } from "../common/cx.ts"

function tier(confidence?: number): "high" | "mid" | "low" {
	if (confidence == null) return "mid"

	return confidence >= 0.8 ? "high" : confidence >= 0.5 ? "mid" : "low"
}

export interface ConfidenceCellProps {
	confidence?: number
}

export function ConfidenceCell({ confidence }: ConfidenceCellProps) {
	if (confidence == null) return <span className="mw-conf__dash">—</span>

	const pct = Math.max(0, Math.min(1, confidence)) * 100

	return (
		<div className="mw-conf">
			<div className={cx("mw-conf__bar", `mw-conf__bar--${tier(confidence)}`)} style={{ width: `${pct}%` }} />
			<span className="mw-conf__value">{confidence.toFixed(2)}</span>
		</div>
	)
}
