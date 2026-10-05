/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The opportunity map application. It holds three pieces of state: the selected buildings, the applied control
 *   values and the map scale. Every value on the page comes from one `opportunityView` of the Example District for
 *   those values and that selection.
 *
 *   The keyboard path runs in document order: the scale control, the building list, the clear button, the map, the
 *   figures and their evidence links, the scenario controls, and the evidence itself.
 */

import "maplibre-gl/dist/maplibre-gl.css"
import "@mailwoman/react/tokens.css"
import "./styles/app.css"
import type { EntityID } from "@mailwoman/dossier"
import { type ReactNode, useCallback, useMemo, useState } from "react"

import { basemapStyle } from "#basemap"
import { controlDefaults, type ControlValues } from "#controls"
import { MapScale, OpportunityMap } from "#map/OpportunityMap"
import { BuildingList } from "#panels/BuildingList"
import { DistrictTable } from "#panels/DistrictTable"
import { EvidenceSection } from "#panels/EvidenceSection"
import { InputTable } from "#panels/InputTable"
import { Legend } from "#panels/Legend"
import { ScenarioControls } from "#panels/ScenarioControls"
import { SegmentList } from "#panels/SegmentList"
import { SelectionFigures } from "#panels/SelectionFigures"
import { EXAMPLE_DISTRICT, opportunityView } from "#view"

/**
 * Injected by the Vite `define` from `OPPORTUNITY_BASEMAP_URL` at build time,
 * or `null` when the build has none.
 */
declare const __OPPORTUNITY_BASEMAP_URL__: string | null

const SCALES: readonly { scale: MapScale; label: string }[] = [
	{ scale: MapScale.Buildings, label: "Buildings" },
	{ scale: MapScale.Districts, label: "Districts" },
]

export function App(): ReactNode {
	const dataset = EXAMPLE_DISTRICT
	const [defaults] = useState(() => controlDefaults(dataset.scenario))
	const [values, setValues] = useState<ControlValues>(defaults)
	const [selected, setSelected] = useState<ReadonlySet<EntityID>>(() => new Set())
	const [scale, setScale] = useState<MapScale>(MapScale.Buildings)
	const [basemapURL] = useState(() => __OPPORTUNITY_BASEMAP_URL__)
	const mapStyle = useMemo(() => basemapStyle(basemapURL), [basemapURL])
	const view = useMemo(() => opportunityView(dataset, values, selected), [dataset, values, selected])

	const toggle = useCallback((building: EntityID) => {
		setSelected((current) => {
			const next = new Set(current)

			if (next.has(building)) {
				next.delete(building)
			} else {
				next.add(building)
			}

			return next
		})
	}, [])

	const clear = useCallback(() => setSelected(new Set()), [])

	return (
		<div className="app">
			<header className="app__header">
				<h1>Opportunity map</h1>
				<p>
					The Example District: every position, route path and economic input on this page is synthetic. This
					application is private and is not deployed.
				</p>
			</header>

			<div className="app__body">
				<aside className="app__sidebar" aria-label="Map scale, buildings and districts">
					<fieldset className="scale">
						<legend>Map scale</legend>
						{SCALES.map((entry) => (
							<label key={entry.scale}>
								<input
									type="radio"
									name="map-scale"
									value={entry.scale}
									checked={scale === entry.scale}
									onChange={() => setScale(entry.scale)}
								/>
								{entry.label}
							</label>
						))}
					</fieldset>

					<BuildingList features={view.buildings.features} selected={selected} onToggle={toggle} onClear={clear} />

					{scale === MapScale.Districts ? (
						<DistrictTable districts={view.districts} extentKind={dataset.extentKind} labels={view.labels} />
					) : null}
				</aside>

				<main className="app__main">
					<section className="map-panel" aria-labelledby="map-heading">
						<h2 id="map-heading" className="visually-hidden">
							Map
						</h2>
						<p className="visually-hidden">
							The map repeats the building list, the district table and the segment list, and its markers state no fact
							that those lists lack.
						</p>
						<div className="map-frame">
							<OpportunityMap
								view={view}
								paths={dataset.paths}
								scale={scale}
								mapStyle={mapStyle}
								selected={selected}
								attribution={basemapURL !== null}
							/>
						</div>
						<Legend />
					</section>

					<div className="panels">
						<SelectionFigures
							economics={view.economics}
							scenario={view.scenario}
							selection={view.selection}
							labels={view.labels}
						/>
						<SegmentList routes={view.routes} labels={view.labels} />
						<ScenarioControls defaults={defaults} currency={dataset.scenario.currency} onApply={setValues} />
						<InputTable inputs={view.inputs} />
					</div>

					<EvidenceSection
						selection={view.selection}
						labels={view.labels}
						dossierParts={view.dossierParts}
						costAndValue={view.costAndValue}
					/>
				</main>
			</div>
		</div>
	)
}
