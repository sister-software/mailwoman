/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `useMapLabelPick` — clicking a place label on the map searches for it, the way the reference map apps behave.
 *
 *   A label on a map looks like a link, so a visitor clicks it. Without this the click reaches the map's pan handler
 *   and nothing happens, which reads as the label being decoration.
 *
 *   It reads the label's OWN name from the rendered feature rather than reverse-geocoding the click point: the name
 *   is what the visitor pointed at, and a lookup by coordinate answers whatever is nearest instead, which on a dense
 *   basemap is regularly not the thing under the cursor.
 *
 *   The pointer turns while a label is under it, because a target that does not say it is clickable is not one.
 */

import { useEffect } from "react"
import type { MapInstance, MapLayerMouseEvent } from "react-map-gl/maplibre"

/**
 * The layers whose features carry a place name. Protomaps names its label layers `<theme>_label` and its settlement
 * layers `places_*`; anything else in the style is geometry, not a label a visitor can read and point at.
 */
const LABEL_LAYER = /_label|^places_/

/**
 * Properties a label carries its text under, in the order they are trusted. `name` is protomaps' own; the localized
 * variants appear on styles built for a specific script.
 */
const NAME_KEYS = ["name", "name:en", "name_en"] as const

function labelNameAt(map: MapInstance, point: MapLayerMouseEvent["point"]): string | null {
	// `queryRenderedFeatures` answers in paint order with the topmost first, which is the label drawn over the others
	// and therefore the one a click landed on.
	const features = map.queryRenderedFeatures(point)

	for (const feature of features) {
		if (!LABEL_LAYER.test(feature.layer?.id ?? "")) continue

		for (const key of NAME_KEYS) {
			const value = feature.properties?.[key]

			if (typeof value === "string" && value.trim()) return value
		}
	}

	return null
}

export function useMapLabelPick(map: MapInstance | null, onPick: (name: string) => void): void {
	useEffect(() => {
		if (!map) return

		const onClick = (event: MapLayerMouseEvent) => {
			const name = labelNameAt(map, event.point)

			if (name) {
				onPick(name)
			}
		}

		const onMove = (event: MapLayerMouseEvent) => {
			const canvas = map.getCanvas()

			// The drag cursor belongs to the pan gesture; overriding it mid-drag would fight the map for the pointer.
			if (canvas.style.cursor === "grabbing") return

			canvas.style.cursor = labelNameAt(map, event.point) ? "pointer" : ""
		}

		map.on("click", onClick)
		map.on("mousemove", onMove)

		return () => {
			map.off("click", onClick)
			map.off("mousemove", onMove)
			map.getCanvas().style.cursor = ""
		}
	}, [map, onPick])
}
