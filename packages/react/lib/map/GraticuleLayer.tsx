/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<GraticuleLayer>` — a meridian/parallel grid drawn UNDER the basemap, so the globe has a readable surface before
 *   a single tile has arrived.
 *
 *   Without it the first seconds of a visit are a black disc: the projection is drawing a sphere, the sphere has no
 *   data on it yet, and a sphere with nothing on it is indistinguishable from a broken map. That is not hypothetical —
 *   this repository spent a day and three wrong diagnoses on a black globe that turned out to be a throttled
 *   background tab, and what made the symptom so convincing is that an empty globe looks exactly like a failure. A
 *   grid makes "loading" and "broken" different pictures. Apple Maps does the same thing for the same reason.
 *
 *   It sits under the basemap rather than over it, so a loaded tile hides its own patch of grid and the grid survives
 *   only where there is nothing else to show — which is precisely where it is doing work.
 *
 *   NODE-SAFE: pure React over a pure geometry builder, no maplibre import.
 */

import { type ReactNode, useMemo } from "react"
import { Layer, Source } from "react-map-gl/maplibre"

import { buildGraticule } from "./graticule.ts"

export interface GraticuleLayerProps {
	/**
	 * The basemap layer to insert beneath — the id of the lowest layer that draws data. Omit and the grid renders on top
	 * of the basemap, which is wrong but not broken: `<Layer>` with no `beforeId` appends.
	 */
	beforeId?: string
	/**
	 * Hide the grid. @default false
	 */
	hidden?: boolean
}

export function GraticuleLayer({ beforeId, hidden = false }: GraticuleLayerProps): ReactNode {
	const data = useMemo(() => buildGraticule(), [])

	// `<Source>` and `<Layer>` as SIBLINGS with an explicit `source`, matching `OverlayLayers`. Nesting the layer
	// inside the source renders nothing here — no source, no layer, and no error to say so.
	return (
		<>
			<Source id="mw-graticule" type="geojson" data={data} />
			<Layer
				id="mw-graticule-line"
				type="line"
				source="mw-graticule"
				{...(beforeId ? { beforeId } : {})}
				layout={{ visibility: hidden ? "none" : "visible", "line-cap": "round" }}
				paint={{
					"line-color": "#8aa0c8",
					// Fades out as the globe gives way to a street map: the grid is orientation for a whole-earth view and
					// clutter by z8, at which point there are tiles to look at anyway.
					"line-opacity": ["interpolate", ["linear"], ["zoom"], 0, 0.3, 3, 0.2, 6, 0.09, 8, 0],
					"line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.5, 4, 0.75],
				}}
			/>
		</>
	)
}
