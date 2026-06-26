/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ControlPosition, LngLat, MapGeoJSONFeature, MapLayerMouseEvent, MapLibreMap, Point } from "maplibre-gl"
import "maplibre-gl/dist/maplibre-gl.css"
import { Fragment, memo, useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { IControl, MapInstance } from "react-map-gl/maplibre"
import styles from "./_debug.module.css"

class DebugControlBase implements IControl {
	public readonly container: HTMLElement

	constructor() {
		this.container = document.createElement("div")
		this.container.classList.add(styles.featureTargets)
	}

	public onAdd(_map: MapInstance): HTMLElement {
		return this.container
	}

	public onRemove(_map: MapInstance): void {
		this.container.remove()
	}

	public getDefaultPosition(): ControlPosition {
		return "bottom-right"
	}
}

export function useMapPointerInfo(map: MapLibreMap | null) {
	const [_pointerPosition, setPointerPosition] = useState<Point>()
	const [pointerCoords, setPointerCoords] = useState<LngLat>()
	const [featureTargets, setFeatureTargets] = useState<MapGeoJSONFeature[]>()
	const [zoomLevel, setZoomLevel] = useState<number>(0)

	useEffect(() => {
		if (!map) return

		let focusMode = false

		const synchronize = (event: MapLayerMouseEvent) => {
			const nextPointerPosition = event.point
			const nextPointerCoords = event.lngLat.wrap()

			setPointerCoords(nextPointerCoords)
			setPointerPosition(nextPointerPosition)

			if (focusMode) {
				const nextFeatureTargets = event.target
					.queryRenderedFeatures(nextPointerPosition, {
						filter: ["!=", ["get", "pmap:kind"], "earth"],
					})
					.filter((feature) => (feature.layer.metadata as { queryable?: boolean })?.queryable !== false)
					.slice(0, 5)
				setFeatureTargets(nextFeatureTargets)
			} else {
				setFeatureTargets([])
			}
		}

		const handleMouseMove = (event: MapLayerMouseEvent) => {
			if (focusMode) return
			synchronize(event)
		}

		const handleClick = (event: MapLayerMouseEvent) => {
			focusMode = !focusMode
			synchronize(event)
		}

		const handleZoom = () => {
			setZoomLevel(map.getZoom())
		}

		map.on("zoom", handleZoom)
		map.on("load", handleZoom)

		map.on("mousemove", handleMouseMove)
		map.on("click", handleClick)

		return () => {
			map.off("mousemove", handleMouseMove)
			map.off("click", handleClick)
			map.off("zoom", handleZoom)
			map.off("load", handleZoom)
		}
	}, [map])

	return { pointerCoords, featureTargets, zoomLevel }
}

export interface DebugControlProps {
	map: MapLibreMap | null
}

export const DebugControl: React.FC<DebugControlProps> = memo(({ map }) => {
	const [debugControl] = useState<DebugControlBase>(() => new DebugControlBase())

	useEffect(() => {
		if (!map) return

		map.addControl(debugControl)
		return () => {
			map.removeControl(debugControl)
		}
	}, [map, debugControl])

	const { pointerCoords, featureTargets, zoomLevel } = useMapPointerInfo(map)

	return createPortal(
		<>
			{featureTargets?.map((feature, index) => {
				const layerID = feature.layer.id

				const isNamed = "pmap:kind" in feature.properties
				const entries: [string, unknown][] = isNamed
					? []
					: Object.entries(feature.properties).filter(
							([key]) => !(key.startsWith("name") || key.startsWith("pmap:") || key.startsWith("pgf"))
						)

				return (
					<div key={index}>
						{feature.properties.name ? (
							<div>
								<strong>{feature.properties.name}</strong>
							</div>
						) : null}
						<strong>{layerID}</strong>
						{entries.length ? (
							<dl className={styles.featureProperties}>
								{entries.map(([key, value]) => (
									<Fragment key={key}>
										<dt>{key}</dt>
										<dd>{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd>
									</Fragment>
								))}
							</dl>
						) : null}
					</div>
				)
			})}

			{pointerCoords ? (
				<div className={styles.coordDetails}>
					<span>
						<strong>Longitude:</strong>
						<span>{pointerCoords.lng.toFixed(6)}</span>
					</span>
					<span>
						<strong>Latitude:</strong>
						<span>{pointerCoords.lat.toFixed(6)}</span>
					</span>
					<span>
						<strong>Zoom:</strong>
						<span>{zoomLevel.toFixed(2)}</span>
					</span>
				</div>
			) : null}
		</>,
		debugControl.container
	)
})

DebugControl.displayName = "DebugControl"
