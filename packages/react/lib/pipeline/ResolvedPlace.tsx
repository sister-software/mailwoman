/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `ResolvedPlace` — the "Resolved place" detail list (name, placetype, WOF id, coords, score). Presentational.
 */

import type { ResolvedPlaceView } from "@mailwoman/core/pipeline/client-result"
import type { ReactNode } from "react"

export interface ResolvedPlaceProps {
	place: ResolvedPlaceView
}

export function ResolvedPlace({ place }: ResolvedPlaceProps): ReactNode {
	return (
		<div className="mw-resolved">
			<h2>Resolved place</h2>
			<dl>
				<dt>name</dt>
				<dd>{place.name}</dd>
				<dt>placetype</dt>
				<dd>{place.placetype}</dd>
				{place.tier ? (
					// A street-tier answer is not a gazetteer place: it has a precision instead of an id.
					<>
						<dt>precision</dt>
						<dd>
							{place.tier === "address_point"
								? "📍 exact address point (≤10 m)"
								: `≈ interpolated · ±${place.uncertaintyM ?? "?"} m`}
						</dd>
					</>
				) : (
					<>
						<dt>WOF id</dt>
						<dd>{place.id}</dd>
					</>
				)}
				<dt>coords</dt>
				<dd>
					{place.lat.toFixed(4)}, {place.lon.toFixed(4)}
				</dd>
				<dt>score</dt>
				<dd>{place.score == null ? "unscored" : place.score.toFixed(3)}</dd>
			</dl>
		</div>
	)
}
