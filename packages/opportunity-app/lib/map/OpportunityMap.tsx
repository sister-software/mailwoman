/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The map draws the model's collections inside `MapCanvas`. Route segments are line layers: a verified segment
 *   is solid, a proposed segment dashed, and a shared segment wider. At the building scale each building with a
 *   resolved position is a marker in its state's shape, numbered as its row in the building list. At the district
 *   scale each district's buildings are dots, and the district's marker sits at the first position of its
 *   `MultiPoint`, because a centroid would be a position the model did not compute.
 *
 *   The canvas draws no text, because a label layer needs a glyph host. Its words are page elements over the
 *   map, and they are hidden from assistive technology because the building list, the district table and the
 *   segment list beside the map state every fact the map shows.
 */

import type { EntityID } from "@mailwoman/dossier"
import { type SegmentPath, SegmentStatus } from "@mailwoman/opportunity-map"
import { MapCanvas, type MapCanvasStyle } from "@mailwoman/react/map/MapCanvas"
import { type ReactNode, useMemo, useState } from "react"
import { Layer, Marker, Source } from "react-map-gl/maplibre"

import { StateGlyph } from "#glyphs"
import type { OpportunityView } from "#view"
import { districtHeading, SEGMENT_WORDS, STATE_WORDS } from "#words"

/**
 * The collection the map draws besides the route segments.
 */
export const MapScale = {
	Buildings: "buildings",
	Districts: "districts",
} as const

export type MapScale = (typeof MapScale)[keyof typeof MapScale]

const VERIFIED_LINE = "#1f5f8b"
const PROPOSED_LINE = "#b0306a"
const LINE_WIDTH = 4
const SHARED_LINE_WIDTH = 8
const FRAME_PADDING = 72
const FRAME_MAX_ZOOM = 17

export interface OpportunityMapProps {
	view: OpportunityView
	/**
	 * Every route path of the dataset.
	 * The camera frames these paths with the buildings.
	 */
	paths: readonly SegmentPath[]
	scale: MapScale
	mapStyle: MapCanvasStyle
	selected: ReadonlySet<EntityID>
	/**
	 * Whether the style draws a tileset whose attribution the map must show.
	 */
	attribution: boolean
}

/**
 * The camera that frames the buildings' positions and the route paths.
 *
 * The bounds are the extremes of those positions, so the framing computes no new position.
 */
function framing(buildings: OpportunityView["buildings"], paths: readonly SegmentPath[]) {
	const points = [
		...buildings.features.flatMap((feature) => (feature.geometry ? [feature.geometry.coordinates] : [])),
		...paths.flatMap((path) => path.coordinates),
	]

	if (!points.length) return { longitude: 0, latitude: 0, zoom: 1 }

	const longitudes = points.map(([longitude]) => longitude)
	const latitudes = points.map(([, latitude]) => latitude)

	return {
		bounds: [
			[Math.min(...longitudes), Math.min(...latitudes)],
			[Math.max(...longitudes), Math.max(...latitudes)],
		] as [[number, number], [number, number]],
		fitBoundsOptions: { padding: FRAME_PADDING, maxZoom: FRAME_MAX_ZOOM },
	}
}

export function OpportunityMap({
	view,
	paths,
	scale,
	mapStyle,
	selected,
	attribution,
}: OpportunityMapProps): ReactNode {
	// The map frames the buildings once, when it mounts, so a later change never moves the camera under the reader.
	const [initialViewState] = useState(() => framing(view.buildings, paths))

	const routes = view.routes.status === "computed" ? view.routes.value : null

	const districts = useMemo(
		() => ({ ...view.districts, features: view.districts.features.filter((feature) => feature.geometry) }),
		[view.districts]
	)

	return (
		<MapCanvas
			mapStyle={mapStyle}
			initialViewState={initialViewState}
			projection="mercator"
			className="opportunity-map"
			style={{ width: "100%", height: "100%" }}
			mapProps={{ attributionControl: attribution ? { compact: true } : false }}
		>
			{routes ? (
				<Source id="routes" type="geojson" data={routes}>
					<Layer
						id="routes-verified"
						type="line"
						filter={["==", ["get", "status"], SegmentStatus.Verified]}
						layout={{ "line-cap": "round", "line-join": "round" }}
						paint={{
							"line-color": VERIFIED_LINE,
							"line-width": ["case", ["get", "shared"], SHARED_LINE_WIDTH, LINE_WIDTH],
						}}
					/>
					<Layer
						id="routes-proposed"
						type="line"
						filter={["==", ["get", "status"], SegmentStatus.Proposed]}
						layout={{ "line-join": "round" }}
						paint={{
							"line-color": PROPOSED_LINE,
							"line-width": ["case", ["get", "shared"], SHARED_LINE_WIDTH, LINE_WIDTH],
							"line-dasharray": [2, 1.5],
						}}
					/>
				</Source>
			) : null}

			{routes?.features.map((feature) => {
				const { coordinates } = feature.geometry
				const [longitude, latitude] = coordinates[Math.floor(coordinates.length / 2)]!
				const { segment, status, shared } = feature.properties

				return (
					<Marker key={`segment-${segment}`} longitude={longitude} latitude={latitude} anchor="left" offset={[10, 0]}>
						<span className={`map-label map-label--${status}`} aria-hidden="true">
							{segment}: {SEGMENT_WORDS[status]}
							{shared ? ", shared" : ""}
						</span>
					</Marker>
				)
			})}

			{scale === MapScale.Buildings
				? view.buildings.features.map((feature, index) => {
						if (!feature.geometry) return null

						const [longitude, latitude] = feature.geometry.coordinates
						const { building, label, state } = feature.properties
						const isSelected = selected.has(building)

						return (
							<Marker key={building} longitude={longitude} latitude={latitude} anchor="center">
								<span
									className={`building-marker state--${state}${isSelected ? " building-marker--selected" : ""}`}
									title={`${label}: ${STATE_WORDS[state]}${isSelected ? ", selected" : ""}`}
									aria-hidden="true"
								>
									<StateGlyph state={state} selected={isSelected} size={30} />
									<span className="building-marker__number">{index + 1}</span>
								</span>
							</Marker>
						)
					})
				: null}

			{scale === MapScale.Districts ? (
				<Source id="districts" type="geojson" data={districts}>
					<Layer
						id="district-buildings"
						type="circle"
						paint={{
							"circle-radius": 6,
							"circle-color": "#ffffff",
							"circle-stroke-width": 3,
							"circle-stroke-color": "#3d4a5c",
						}}
					/>
				</Source>
			) : null}

			{scale === MapScale.Districts
				? districts.features.map((feature) => {
						const [longitude, latitude] = feature.geometry!.coordinates[0]!
						const { properties } = feature

						return (
							<Marker
								key={districtHeading(properties)}
								longitude={longitude}
								latitude={latitude}
								anchor="bottom"
								offset={[0, -10]}
							>
								<span className="district-marker" aria-hidden="true">
									<strong>{districtHeading(properties)}</strong>
									<span>{properties.units.resolved} resolved units</span>
									<span>{properties.units.unresolvedBuildings} with an unresolved total</span>
								</span>
							</Marker>
						)
					})
				: null}
		</MapCanvas>
	)
}
