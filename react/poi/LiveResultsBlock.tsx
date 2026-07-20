/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `LiveResultsBlock` — the on-demand live poi.db search affordance: a "Search live" button plus the
 *   idle / loading / error / results states. Presentational — all behavior comes in via props (the
 *   `usePOISearch` hook owns the state machine + the injected probe).
 */

import type { ReactNode } from "react"

import { formatDistance } from "./runtime.ts"
import type { LiveSearchState } from "./types.ts"

export interface LiveResultsBlockProps {
	/** Subject label for empty-state copy — a category ("No hospital results near …") or a brand ("No chevron results …"). */
	subjectLabel: string
	/** The location anchor the search runs against (empty ⇒ the button is disabled with a hint). */
	anchor: string
	state: LiveSearchState
	onSearch: () => void
}

export function LiveResultsBlock({ subjectLabel, anchor, state, onSearch }: LiveResultsBlockProps): ReactNode {
	const hasAnchor = anchor.trim().length > 0

	return (
		<div className="mw-live">
			<div className="mw-panel__header">
				<h3>Live results</h3>
				<button
					type="button"
					className="mw-btn"
					onClick={onSearch}
					disabled={!hasAnchor || state.status === "loading"}
					title={hasAnchor ? "Search the published poi.db layer" : 'Needs a location anchor (e.g. "near Springfield")'}
				>
					{state.status === "loading" ? "Searching…" : "Search live"}
				</button>
			</div>

			{!hasAnchor ? (
				<p className="mw-muted">Add a location anchor (e.g. "near Springfield") to search live.</p>
			) : state.status === "error" ? (
				<p className="mw-error">{state.message}</p>
			) : state.status === "success" ? (
				state.hits.length === 0 ? (
					<p className="mw-muted">
						No {subjectLabel.toLowerCase()} results near {state.centerName}.
					</p>
				) : (
					<>
						<p className="mw-live__caption">Near {state.centerName}, ranked by distance:</p>
						<ul className="mw-live__results">
							{state.hits.map((hit, i) => (
								<li key={`${hit.name}-${i}`}>
									<span className="mw-live__name">{hit.name}</span>
									<span className="mw-live__meta">
										{formatDistance(hit.distanceM)} · {hit.country}
									</span>
								</li>
							))}
						</ul>
					</>
				)
			) : null}
		</div>
	)
}
