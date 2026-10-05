/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The segment list repeats the route lines of the map in words: each segment's status, whether the selection
 *   shares it, the basis that makes it verified or proposed, and its cost in the selection.
 */

import type { EntityID } from "@mailwoman/dossier"
import type { RouteCollection } from "@mailwoman/opportunity-map"
import type { ReactNode } from "react"

import { SegmentGlyph } from "#glyphs"
import type { Outcome } from "#view"
import { segmentText } from "#words"

export interface SegmentListProps {
	routes: Outcome<RouteCollection>
	labels: ReadonlyMap<EntityID, string>
}

export function SegmentList({ routes, labels }: SegmentListProps): ReactNode {
	return (
		<section className="panel" aria-labelledby="segments-heading">
			<h2 id="segments-heading">Route segments</h2>
			{routes.status === "empty" ? (
				<p className="panel__note">No building is selected, so the selection uses no route segment.</p>
			) : null}
			{routes.status === "refused" ? (
				<>
					<p className="panel__note">The model drew no route for this selection. Its message:</p>
					<p className="refusal">{routes.message}</p>
				</>
			) : null}
			{routes.status === "computed" ? (
				<ul className="segment-list" aria-label="Route segments">
					{routes.value.features.map(({ properties }) => (
						<li key={properties.segment} className={`segment segment--${properties.status}`}>
							<SegmentGlyph status={properties.status} shared={properties.shared} />
							<span>{segmentText(properties, labels)}</span>
						</li>
					))}
				</ul>
			) : null}
		</section>
	)
}
