/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `CandidatePicker` — the ranked list of alternate gazetteer candidates. clicking one selects it.
 *   Presentational. the selected index is owned by the caller (the pipeline hook).
 *
 *   The row shows the RANK rather than the score. `ResolvedPlaceView.score` is implementation-defined — its own type says
 *   "callers should treat as ordinal" — and the backends do not agree on a scale: the FTS regime is a negated bm25
 *   plus additive tiers, while the candidate regime is exactly `log10(population + 1)`. Printing both put
 *   "New York · 6.95" (log10 of 8.9M) directly under "350 5th Ave · 1.00" from a bounded blend, which reads as one
 *   number beating another by a factor of seven rather than as two numbers that never shared a scale.
 *   `docs/records/reviews/2026-08-04-resolver-score-abstention.md` measures this in full.
 *
 *   The raw value stays on the button's `title`, at full precision, because it is exactly the right thing to have
 *   when you are debugging a ranking and exactly the wrong thing to put in a visitor's eyeline.
 */

import type { ResolvedPlaceView } from "@mailwoman/core/pipeline/client-result"
import type { ReactNode } from "react"

import { cx } from "#common/cx"

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
							<span className="mw-candidates__meta">{candidate.placetype}</span>
						</button>
					</li>
				))}
			</ol>
		</div>
	)
}
