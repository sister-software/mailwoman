/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Renders the body's style over `MapCanvas`.
 *   A label click selects the feature beneath it. A ring marks the selected ID.
 *   The camera frames a selection by its diameter.
 *   The map composes its style once per config. A selection changes only a layer filter.
 */

import {
	createPlanetaryStyle,
	PlanetaryHillshadeSourceID,
	PlanetaryLabelsLayerID,
	PlanetarySelectionLayerID,
} from "@mailwoman/cartographer/planetary"
import { MapCanvas } from "@mailwoman/react/map/MapCanvas"
import { ResultCamera } from "@mailwoman/react/map/ResultCamera"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
	/**
	 * The live map after react-map-gl instantiates it.
	 *
	 * The value is `null` on unmount.
	 * Chrome outside this component cannot reach the handle through `useMap()`.
	 * The compass reads the map direction from this value.
	 */
	onMapReady?: (map: ReturnType<MapRef["getMap"]> | null) => void
}

export function PlanetaryMap({ config, selected, onSelect, onMapReady }: PlanetaryMapProps) {
	const mapRef = useRef<MapRef>(null)

	// The chrome outside this component cannot re-render from a ref,
	// so the handle goes up to the parent as state.
	const publishMap = useCallback(
		(event: { target: ReturnType<MapRef["getMap"]> }) => onMapReady?.(event.target),
		[onMapReady]
	)

	useEffect(() => () => onMapReady?.(null), [onMapReady])

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

	// The deepest zoom in the body's terrain archive, read from the live source once it resolves its TileJSON.
	// The two bodies differ, so a constant clamp would over-zoom one of them.
	const [maxTerrainZoom, setMaxTerrainZoom] = useState<number | undefined>(undefined)

	useEffect(() => {
		const map = mapRef.current?.getMap()

		if (!map) return

		const read = () => {
			const source = map.getSource(PlanetaryHillshadeSourceID)
			const maxzoom = (source as { maxzoom?: number } | undefined)?.maxzoom

			if (typeof maxzoom === "number") {
				setMaxTerrainZoom(maxzoom)
			}
		}

		read()
		map.on("sourcedata", read)

		return () => {
			map.off("sourcedata", read)
		}
	}, [])

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
			mapProps={{
				interactiveLayerIds: [PlanetaryLabelsLayerID],
				onClick,
				onLoad: publishMap,
				attributionControl: false,
			}}
		>
			{selected ? (
				<ResultCamera
					target={{
						kind: "center",
						center: [selected.centerLon, selected.centerLat],
						zoom: framingZoom(selected.diameterKm ?? null, maxTerrainZoom),
					}}
					animate={!prefersReducedMotion()}
				/>
			) : null}
		</MapCanvas>
	)
}
