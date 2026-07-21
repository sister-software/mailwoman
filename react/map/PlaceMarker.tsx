/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<PlaceMarker>` — the resolved-place pin, as a declarative `react-map-gl/maplibre` `<Marker>`. This
 *   replaces the old imperative `new maplibre.Marker(...).setLngLat(...).addTo(map)` (+ the manual
 *   `markerRef.current.remove()` teardown) from the demo's redraw effect: mounting/unmounting the marker
 *   is now React's job, keyed on the resolved candidate. Renders as a child of `<DemoMap>`.
 *
 *   NODE-IMPORT SAFETY: imports `react-map-gl/maplibre` at module scope, so it is reachable ONLY through
 *   the `@mailwoman/react/map` subpath, never the package root.
 */

import type { ReactNode } from "react"
import { Marker } from "react-map-gl/maplibre"

/** The house pink the demo has always drawn the resolved-place marker in. */
const MARKER_COLOR = "#e0367c"

export interface PlaceMarkerProps {
	/** Marker longitude. */
	longitude: number
	/** Marker latitude. */
	latitude: number
	/** Pin color. @default the house pink. */
	color?: string
	/** Which part of the marker sits on the coordinate. @default "center" (a symmetric dot). */
	anchor?: "center" | "top" | "bottom" | "left" | "right"
}

/** A single resolved-place marker. Wraps `react-map-gl`'s `<Marker>` with the demo's default color. */
export function PlaceMarker({
	longitude,
	latitude,
	color = MARKER_COLOR,
	anchor = "center",
}: PlaceMarkerProps): ReactNode {
	return <Marker longitude={longitude} latitude={latitude} color={color} anchor={anchor} />
}
