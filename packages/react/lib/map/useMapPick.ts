// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Every click on the map as what it landed on: a place label, a rendered feature with a name such as a
 *   lake or a park, or bare ground, each with a coordinate. A label is hit within a padded box around the
 *   pointer, because a label's glyphs are a small target. The hook resolves the layer list once per style and
 *   throttles the hover query to one per animation frame.
 */

import { pointInMultiPolygon, pointInPolygon, type PolygonRings } from "@mailwoman/spatial/geometries/polygon"
import { useEffect, useEffectEvent } from "react"
import type { MapGeoJSONFeature, MapInstance, MapLayerMouseEvent } from "react-map-gl/maplibre"

import type { LngLat } from "#map/place-render"

/**
 * The protomaps label layers (`<theme>_label`, `places_*`); other layers are geometry
 * rather than readable place names.
 */
const LABEL_LAYER = /_label|^places_/

/**
 * Properties that may contain a label's text, in trust order.
 *
 * `name` comes from Protomaps.
 * Localized variants appear in script-specific styles.
 */
const NAME_KEYS = ["name", "name:en", "name_en"] as const

/**
 * Properties that say what kind of feature this is, in trust order: Protomaps writes `kind_detail`
 * for the finer kind (`lake` under `water`) and `kind`, and older tiles `pmap:kind`.
 */
const KIND_KEYS = ["kind_detail", "kind", "pmap:kind"] as const

/**
 * The land polygon's kind: it is under every click on land, so it identifies no place.
 */
const EARTH_KIND = "earth"

/**
 * How far from the pointer, in CSS pixels, a label still counts as clicked.
 */
const LABEL_PADDING_PX = 8

/**
 * What a click landed on.
 */
export interface MapPick {
	/**
	 * `label` for a place label, `feature` for another rendered feature with a name, `ground` for the rest.
	 */
	kind: "label" | "feature" | "ground"
	/**
	 * The feature's name, or `null` for bare ground.
	 */
	name: string | null
	/**
	 * The feature's kind as the tiles record it, such as `locality` or `lake`, or `null`.
	 */
	placetype: string | null
	/**
	 * The feature's own point for a point feature, else the clicked coordinate, as `[lon, lat]`.
	 */
	lngLat: LngLat
}

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

function nameOf(feature: MapGeoJSONFeature): string | null {
	for (const key of NAME_KEYS) {
		const value = feature.properties?.[key]

		if (typeof value === "string" && value.trim()) return value
	}

	return null
}

function kindOf(feature: MapGeoJSONFeature): string | null {
	for (const key of KIND_KEYS) {
		const value = feature.properties?.[key]

		if (typeof value === "string" && value) return value
	}

	return null
}

/**
 * The feature's own point when it is one, else the clicked coordinate.
 */
function pointOf(feature: MapGeoJSONFeature, fallback: LngLat): LngLat {
	if (feature.geometry.type === "Point") {
		const [lon, lat] = feature.geometry.coordinates

		if (typeof lon === "number" && typeof lat === "number") return [lon, lat]
	}

	return fallback
}

/**
 * The topmost label with a name within the padded box around `point`, or `null`.
 *
 * `queryRenderedFeatures` answers topmost-first, so the first feature with a
 * name is the one the click landed on.
 */
function labelAt(map: MapInstance, point: MapLayerMouseEvent["point"], layers: string[]): MapGeoJSONFeature | null {
	if (!layers.length) return null

	const box: [[number, number], [number, number]] = [
		[point.x - LABEL_PADDING_PX, point.y - LABEL_PADDING_PX],
		[point.x + LABEL_PADDING_PX, point.y + LABEL_PADDING_PX],
	]

	return map.queryRenderedFeatures(box, { layers }).find((feature) => nameOf(feature) !== null) ?? null
}

/**
 * Whether `lngLat` falls inside a rendered polygon feature.
 *
 * A rendered polygon is the piece inside its tile, so a point in another tile reads as outside.
 */
function polygonContains(feature: MapGeoJSONFeature, [lon, lat]: LngLat): boolean {
	const { geometry } = feature

	if (geometry.type === "Polygon") return pointInPolygon(lon, lat, geometry.coordinates as PolygonRings)

	if (geometry.type === "MultiPolygon") {
		return pointInMultiPolygon(lon, lat, geometry.coordinates as PolygonRings[])
	}

	return false
}

/**
 * The name of an unnamed polygon, read from a rendered label point of the polygon's own label layers
 * that falls inside it: the tiles name a lake on its label point and not on its water polygon.
 *
 * The label layers of a feature layer share its id as a prefix, `water_label_lakes` for `water`.
 * A label in another tile than the clicked piece is not found, and the polygon then stays unnamed.
 */
function nameFromLabelInside(map: MapInstance, polygon: MapGeoJSONFeature, layers: string[]): string | null {
	const ownLabels = layers.filter((id) => id.startsWith(`${polygon.layer.id}_label`))

	if (!ownLabels.length) return null

	for (const label of map.queryRenderedFeatures(undefined, { layers: ownLabels })) {
		if (label.geometry.type !== "Point") continue

		const name = nameOf(label)
		const [lon, lat] = label.geometry.coordinates

		if (name && typeof lon === "number" && typeof lat === "number" && polygonContains(polygon, [lon, lat])) {
			return name
		}
	}

	return null
}

/**
 * The topmost feature under `point` on any layer but the land polygon, with its name, or `null`.
 *
 * A feature with a name answers first.
 * An unnamed polygon answers with the name of its own label when that label is inside
 * the rendered piece, and else with its kind and no name.
 */
function featureAt(
	map: MapInstance,
	point: MapLayerMouseEvent["point"],
	layers: string[]
): { feature: MapGeoJSONFeature; name: string | null } | null {
	const features = map.queryRenderedFeatures(point).filter((feature) => kindOf(feature) !== EARTH_KIND)
	const named = features.find((feature) => nameOf(feature) !== null)

	if (named) return { feature: named, name: nameOf(named) }

	const polygon = features.find((feature) => feature.geometry.type.endsWith("Polygon"))

	if (!polygon) return null

	return { feature: polygon, name: nameFromLabelInside(map, polygon, layers) }
}

/**
 * What a click at `event` landed on.
 */
function pickAt(map: MapInstance, event: MapLayerMouseEvent, layers: string[]): MapPick {
	const clicked: LngLat = [event.lngLat.lng, event.lngLat.lat]
	const label = labelAt(map, event.point, layers)

	if (label) {
		return { kind: "label", name: nameOf(label), placetype: kindOf(label), lngLat: pointOf(label, clicked) }
	}

	const found = featureAt(map, event.point, layers)

	if (found) {
		return { kind: "feature", name: found.name, placetype: kindOf(found.feature), lngLat: clicked }
	}

	return { kind: "ground", name: null, placetype: null, lngLat: clicked }
}

/**
 * Routes every map click to `onPick` with what it landed on, and shows a pointer over a label.
 */
export function useMapPick(map: MapInstance | null, onPick: (pick: MapPick) => void): void {
	// The subscription depends only on the map.
	// `onPick` changes on every render.
	// `useEffectEvent` reads the latest callback without adding it as a reactive dependency.
	const pick = useEffectEvent((picked: MapPick) => onPick(picked))

	useEffect(() => {
		if (!map) return

		// Recomputed when the style swaps.
		// Pointer moves read the cached list.
		let layers = labelLayerIDs(map)

		const readLayers = () => {
			layers = labelLayerIDs(map)
		}

		const onClick = (event: MapLayerMouseEvent) => {
			pick(pickAt(map, event, layers))
		}

		let frame = 0

		const onMove = (event: MapLayerMouseEvent) => {
			if (frame) return

			frame = requestAnimationFrame(() => {
				frame = 0

				const canvas = map.getCanvas()

				// The drag cursor belongs to the pan gesture.
				// An override mid-drag would fight the map for the pointer.
				if (canvas.style.cursor === "grabbing") return

				canvas.style.cursor = labelAt(map, event.point, layers) ? "pointer" : ""
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
