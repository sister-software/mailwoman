/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Clicking a place label on the map searches for its own name, with the layer list resolved once per style and the hover query throttled to one per animation frame.
 */

import { useEffect, useEffectEvent } from "react"
import type { MapInstance, MapLayerMouseEvent } from "react-map-gl/maplibre"

/**
 * The protomaps label layers (`<theme>_label`, `places_*`); other layers are geometry
 * rather than readable place names.
 */
const LABEL_LAYER = /_label|^places_/

/**
 * Properties a label carries its text under, in trust order; `name` is protomaps' own,
 * and the localized variants appear on script-specific styles.
 */
const NAME_KEYS = ["name", "name:en", "name_en"] as const

/**
 * The style's label layer ids.
 *
 * An empty result must stay unqueried, since an empty `layers` option is not the
 * same as an absent one in `queryRenderedFeatures`.
 */
function labelLayerIDs(map: MapInstance): string[] {
	const layers = map.getStyle()?.layers ?? []

	return layers.map((layer) => layer.id).filter((id) => LABEL_LAYER.test(id))
}

function labelNameAt(map: MapInstance, point: MapLayerMouseEvent["point"], layers: string[]): string | null {
	if (!layers.length) return null

	// `queryRenderedFeatures` answers topmost-first, so the first named feature is the one the click landed on.
	for (const feature of map.queryRenderedFeatures(point, { layers })) {
		for (const key of NAME_KEYS) {
			const value = feature.properties?.[key]

			if (typeof value === "string" && value.trim()) return value
		}
	}

	return null
}

/**
 * Routes clicks on map labels to `onPick` with the clicked label's own name.
 */
export function useMapLabelPick(map: MapInstance | null, onPick: (name: string) => void): void {
	// The subscription depends on the map alone; `onPick` is fresh every render,
	// and `useEffectEvent` reads it without becoming a reactive dependency.
	const pick = useEffectEvent((name: string) => onPick(name))

	useEffect(() => {
		if (!map) return

		// Recomputed when the style swaps.
		// Pointer moves read the cached list.
		let layers = labelLayerIDs(map)

		const readLayers = () => {
			layers = labelLayerIDs(map)
		}

		const onClick = (event: MapLayerMouseEvent) => {
			const name = labelNameAt(map, event.point, layers)

			if (name) {
				pick(name)
			}
		}

		let frame = 0

		const onMove = (event: MapLayerMouseEvent) => {
			if (frame) return

			frame = requestAnimationFrame(() => {
				frame = 0

				const canvas = map.getCanvas()

				// The drag cursor belongs to the pan gesture.
				// Overriding it mid-drag would fight the map for the pointer.
				if (canvas.style.cursor === "grabbing") return

				canvas.style.cursor = labelNameAt(map, event.point, layers) ? "pointer" : ""
			})
		}

		map.on("styledata", readLayers)
		map.on("click", onClick)
		map.on("mousemove", onMove)

		return () => {
			if (frame) {
				cancelAnimationFrame(frame)
			}

			map.off("styledata", readLayers)
			map.off("click", onClick)
			map.off("mousemove", onMove)
			map.getCanvas().style.cursor = ""
		}
	}, [map])
}
