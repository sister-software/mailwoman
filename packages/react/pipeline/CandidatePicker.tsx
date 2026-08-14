/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `CandidatePicker` — the ranked list of alternate gazetteer candidates; clicking one selects it.
 *   Presentational; the selected index is owned by the caller (the pipeline hook).
 */

import type { ReactNode } from "react"

import { cx } from "../common/cx.ts"
import type { ResolvedPlaceView } from "./types.ts"

export interface CandidatePickerProps {
	candidates: ResolvedPlaceView[]
	selectedIndex: number
	onSelect: (index: number) => void
}

export function CandidatePicker({ candidates, selectedIndex, onSelect }: CandidatePickerProps): ReactNode {
	return (
		<div className="mw-candidates">
			<h2>Other candidates ({candidates.length - 1})</h2>
			<ol className="mw-candidates__list">
				{candidates.map((candidate, i) => (
					<li key={`${candidate.id}-${i}`}>
						<button
							type="button"
							className={cx("mw-candidates__btn", { "mw-candidates__btn--active": i === selectedIndex })}
							onClick={() => onSelect(i)}
							title={`${candidate.placetype} • WOF ${candidate.id} • score ${candidate.score.toFixed(3)}`}
						>
							<span className="mw-candidates__rank">#{i + 1}</span>
							<span className="mw-candidates__name">{candidate.name}</span>
							<span className="mw-candidates__meta">
								{candidate.placetype} · {candidate.score.toFixed(2)}
							</span>
						</button>
					</li>
				))}
			</ol>
		</div>
	)
}
