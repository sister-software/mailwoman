/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The building list is the keyboard path of the map. Each building is a checkbox row: Tab reaches it and Space
 *   selects or clears it. The checkbox's accessible description gives the word selected when the building is
 *   selected, its state in words and its unit denominator, and the row lists the source records behind the state by
 *   identifier. The number beside each label is the number on the building's map marker.
 */

import type { EntityID } from "@mailwoman/dossier"
import type { BuildingFeature } from "@mailwoman/opportunity-map"
import type { ReactNode } from "react"

import { SelectedGlyph, StateGlyph } from "#glyphs"
import { positionText, STATE_WORDS, unitsText } from "#words"

export interface BuildingListProps {
	features: readonly BuildingFeature[]
	selected: ReadonlySet<EntityID>
	onToggle: (building: EntityID) => void
	onClear: () => void
}

function BuildingRow({
	feature,
	number,
	selected,
	onToggle,
}: {
	feature: BuildingFeature
	number: number
	selected: boolean
	onToggle: (building: EntityID) => void
}): ReactNode {
	const { building, label, state, reason, units, position, sources } = feature.properties
	const id = `building-${number}`
	const describedBy = [...(selected ? [`${id}-selection`] : []), `${id}-state`, `${id}-units`].join(" ")

	return (
		<li className={`building-row state--${state}${selected ? " building-row--selected" : ""}`}>
			<div className="building-row__head">
				<input
					type="checkbox"
					id={`${id}-select`}
					checked={selected}
					onChange={() => onToggle(building)}
					aria-describedby={describedBy}
				/>
				<label htmlFor={`${id}-select`}>{label}</label>
				<span className="building-row__number" aria-hidden="true">
					{number}
				</span>
				{selected ? (
					<span id={`${id}-selection`} className="selection-word">
						<SelectedGlyph />
						selected
					</span>
				) : null}
			</div>
			<p id={`${id}-state`} className="building-row__state">
				<StateGlyph state={state} size={22} />
				{STATE_WORDS[state]}
			</p>
			<p id={`${id}-units`} className="building-row__units">
				{unitsText(units)}
			</p>
			<p className="building-row__detail">{reason}</p>
			<p className="building-row__detail">{positionText(position)}</p>
			{sources.length ? (
				<div className="building-row__sources">
					<span aria-hidden="true">Sources</span>
					<ul aria-label={`Sources behind the state of ${label}`}>
						{sources.map((source) => (
							<li key={source}>
								<code>{source}</code>
							</li>
						))}
					</ul>
				</div>
			) : (
				<p className="building-row__detail">No source record stands behind the state of {label}.</p>
			)}
		</li>
	)
}

export function BuildingList({ features, selected, onToggle, onClear }: BuildingListProps): ReactNode {
	return (
		<section className="panel" aria-labelledby="buildings-heading">
			<h2 id="buildings-heading">Buildings</h2>
			<p className="panel__note">
				Select buildings to recalculate their shared economics. Each row gives its building's state in words, its unit
				denominator and the source records behind the state.
			</p>
			<ul className="building-list" aria-label="Buildings">
				{features.map((feature, index) => (
					<BuildingRow
						key={feature.properties.building}
						feature={feature}
						number={index + 1}
						selected={selected.has(feature.properties.building)}
						onToggle={onToggle}
					/>
				))}
			</ul>
			<button type="button" className="button" onClick={onClear}>
				Clear selection
			</button>
		</section>
	)
}
