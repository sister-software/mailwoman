/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The globe: the body's style over `MapCanvas`, a click on a label selecting the feature beneath it, the selection
 *   ring bound to the selected id, and the camera framing a selection by its diameter. The style is composed once
 *   per config; the selection changes a layer filter, never the style.
 */

import {
	createPlanetaryStyle,
	PlanetaryLabelsLayerID,
	PlanetarySelectionLayerID,
} from "@mailwoman/cartographer/planetary"
import { MapCanvas } from "@mailwoman/react/map/MapCanvas"
import { ResultCamera } from "@mailwoman/react/map/ResultCamera"
import { useCallback, useEffect, useMemo, useRef } from "react"
import type { MapLayerMouseEvent, MapRef } from "react-map-gl/maplibre"

import type { PlanetaryMapConfig } from "#bodies/config"
import type { SelectedFeature } from "#features/selected"
import { featureFromTileProperties } from "#features/tile-properties"
import { prefersReducedMotion, framingZoom } from "#map/camera"
import { viewportFromSearch } from "#routes"

export interface PlanetaryMapProps {
	config: PlanetaryMapConfig
	selected: SelectedFeature | null
	onSelect: (feature: SelectedFeature) => void
}

export function PlanetaryMap({ config, selected, onSelect }: PlanetaryMapProps) {
	const mapRef = useRef<MapRef>(null)

	const style = useMemo(
		() =>
			createPlanetaryStyle({
				body: config.body,
				nomenclatureTileJSONURL: config.tiles.nomenclature,
				hillshadeTileJSONURL: config.tiles.hillshade,
			}),
		[config]
	)

	// Read once: a viewport in the URL wins over the body's opening view for the first render only.
	const initial = useMemo(() => viewportFromSearch(location.search) ?? config.initialView, [config])

	useEffect(() => {
		const map = mapRef.current?.getMap()

		if (!map) return

		const apply = () => map.setFilter(PlanetarySelectionLayerID, ["==", ["get", "id"], selected?.id ?? ""])

		if (map.isStyleLoaded()) {
			apply()

			return
		}

		map.once("load", apply)

		return () => {
			map.off("load", apply)
		}
	}, [selected])

	const onClick = useCallback(
		(event: MapLayerMouseEvent) => {
			const feature = event.features?.[0]

			if (!feature || feature.geometry.type !== "Point") return

			const [longitude, latitude] = feature.geometry.coordinates as [number, number]
			const selection = featureFromTileProperties(feature.properties, { longitude, latitude })

			if (selection) {
				onSelect(selection)
			}
		},
		[onSelect]
	)

	return (
		<MapCanvas
			mapStyle={style}
			initialViewState={initial}
			projection="globe"
			mapRef={mapRef}
			style={{ width: "100%", height: "100%" }}
			mapProps={{ interactiveLayerIds: [PlanetaryLabelsLayerID], onClick, attributionControl: false }}
		>
			{selected ? (
				<ResultCamera
					target={{
						kind: "center",
						center: [selected.centerLon, selected.centerLat],
						zoom: framingZoom(selected.diameterKm),
					}}
					animate={!prefersReducedMotion()}
				/>
			) : null}
		</MapCanvas>
	)
}
