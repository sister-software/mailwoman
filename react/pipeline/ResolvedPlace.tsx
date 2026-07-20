/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `ResolvedPlace` — the "Resolved place" detail list (name, placetype, WOF id, coords, score) plus an
 *   optional dual-role note. Presentational.
 */

import { Fragment, type ReactNode } from "react"

import type { DualRoleView, ResolvedPlaceView } from "./types.ts"

export interface ResolvedPlaceProps {
	place: ResolvedPlaceView
	dualRoles?: DualRoleView[]
}

export function ResolvedPlace({ place, dualRoles }: ResolvedPlaceProps): ReactNode {
	return (
		<div className="mw-resolved">
			<h2>Resolved place</h2>
			<dl>
				<dt>name</dt>
				<dd>{place.name}</dd>
				<dt>placetype</dt>
				<dd>{place.placetype}</dd>
				<dt>WOF id</dt>
				<dd>{place.id}</dd>
				<dt>coords</dt>
				<dd>
					{place.lat.toFixed(4)}, {place.lon.toFixed(4)}
				</dd>
				<dt>score</dt>
				<dd>{place.score.toFixed(3)}</dd>
			</dl>
			{dualRoles && dualRoles.length > 0 ? (
				<p className="mw-resolved__dual">
					🏛️ <strong>Dual-role place.</strong> {place.name} also resolves as{" "}
					{dualRoles.map((role, i) => (
						<Fragment key={`${role.role}-${role.id}`}>
							{i > 0 ? ", " : ""}a <strong>{role.role}</strong> ({role.relationshipType.replace(/-/g, " ")})
						</Fragment>
					))}
					.
				</p>
			) : null}
		</div>
	)
}
