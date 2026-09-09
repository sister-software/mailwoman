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
 *   THE QUERY IS SCOPED, AND THE HOVER QUERY IS THROTTLED. `queryRenderedFeatures` with no `layers` walks the whole
 *   style: measured at 64.3 ms per call returning 4,819 features over the 79-layer basemap at zoom 14 in Manhattan,
 *   against 4.9 ms and 44 features scoped to that style's 11 label layers. At one call per pointer move the unscoped
 *   form is the map's whole frame budget, so the layer list is resolved once per style and the hover query runs at
 *   most once per animation frame. The click query is not throttled — there is one of those per click.
 */

import { useEffect, useEffectEvent } from "react"
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

/**
 * The style's label layers, by id.
 *
 * A style with none answers an EMPTY ARRAY, and the caller must treat that as "no labels to pick" rather than passing
 * it to `queryRenderedFeatures` — an empty `layers` option is not the same as an absent one there, and the difference
 * between "this style has no labels" and "query everything" is the 64 ms this hook exists to avoid.
 */
function labelLayerIDs(map: MapInstance): string[] {
	const layers = map.getStyle()?.layers ?? []

	return layers.map((layer) => layer.id).filter((id) => LABEL_LAYER.test(id))
}

function labelNameAt(map: MapInstance, point: MapLayerMouseEvent["point"], layers: string[]): string | null {
	if (!layers.length) return null

	// `queryRenderedFeatures` answers in paint order with the topmost first, which is the label drawn over the others
	// and therefore the one a click landed on.
	for (const feature of map.queryRenderedFeatures(point, { layers })) {
		for (const key of NAME_KEYS) {
			const value = feature.properties?.[key]

			if (typeof value === "string" && value.trim()) return value
		}
	}

	return null
}

export function useMapLabelPick(map: MapInstance | null, onPick: (name: string) => void): void {
	// The subscription depends on the MAP alone. `useGeocode` returns a fresh object every render, so a callback built
	// from it is new every render too — with `onPick` in the dependency list these map listeners were torn down and
	// re-added on every keystroke in the search field. `useEffectEvent` is the shape for exactly this: an event
	// handler that always sees the latest props without being a reactive dependency.
	const pick = useEffectEvent((name: string) => onPick(name))

	useEffect(() => {
		if (!map) return

		// Recomputed when the style swaps (a theme change, a version switch) and not once per pointer move.
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

				// The drag cursor belongs to the pan gesture; overriding it mid-drag would fight the map for the pointer.
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
