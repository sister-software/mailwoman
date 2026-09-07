/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `ConfidenceCell` — a compact confidence bar + value for the component table. The fill colour follows the shared
 *   confidence tiers. Presentational.
 */

import { confidenceTierOrMid } from "#common/confidence-tiers"
import { cx } from "#common/cx"

export interface ConfidenceCellProps {
	confidence?: number
}

export function ConfidenceCell({ confidence }: ConfidenceCellProps) {
	if (confidence == null) return <span className="mw-conf__dash">—</span>

	const pct = Math.max(0, Math.min(1, confidence)) * 100

	return (
		<div className="mw-conf">
			<div
				className={cx("mw-conf__bar", `mw-conf__bar--${confidenceTierOrMid(confidence)}`)}
				style={{ width: `${pct}%` }}
			/>
			<span className="mw-conf__value">{confidence.toFixed(2)}</span>
		</div>
	)
}
