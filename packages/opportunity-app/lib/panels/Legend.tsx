/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The legend names each shape of the map and the building list in words, in the order of the state rules.
 */

import { BuildingState, SegmentStatus } from "@mailwoman/opportunity-map"
import type { ReactNode } from "react"

import { SegmentGlyph, SelectedGlyph, StateGlyph } from "#glyphs"
import { SEGMENT_WORDS, STATE_WORDS } from "#words"

export function Legend(): ReactNode {
	return (
		<section className="legend" aria-labelledby="legend-heading">
			<h2 id="legend-heading">Legend</h2>
			<ul aria-label="Legend">
				{Object.values(BuildingState).map((state) => (
					<li key={state} className={`state--${state}`}>
						<StateGlyph state={state} />
						{STATE_WORDS[state]}
					</li>
				))}
				<li className="state--partial_availability">
					<StateGlyph state={BuildingState.PartialAvailability} selected />
					<SelectedGlyph />
					selected: a check mark and a heavier outline
				</li>
				<li className={`segment--${SegmentStatus.Verified}`}>
					<SegmentGlyph status={SegmentStatus.Verified} />
					{SEGMENT_WORDS[SegmentStatus.Verified]}: a solid line
				</li>
				<li className={`segment--${SegmentStatus.Proposed}`}>
					<SegmentGlyph status={SegmentStatus.Proposed} />
					{SEGMENT_WORDS[SegmentStatus.Proposed]}: a dashed line
				</li>
				<li className={`segment--${SegmentStatus.Verified}`}>
					<SegmentGlyph status={SegmentStatus.Verified} shared />
					shared segment: a wider line
				</li>
				<li>
					<span className="origin origin--synthetic">synthetic</span>: a figure computed from synthetic inputs
				</li>
			</ul>
		</section>
	)
}
