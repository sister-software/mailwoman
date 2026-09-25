/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Draw a meridian/parallel grid beneath the basemap, keeping an empty globe legible
 *   while tiles load. Loaded tiles cover the grid; it remains visible where data is absent.
 */

import { type ReactNode, useMemo } from "react"
import { Layer, Source } from "react-map-gl/maplibre"

import { buildGraticule } from "./graticule.ts"

export interface GraticuleLayerProps {
	/**
	 * Basemap data layer to place above the grid; omitted layers append the grid on top.
	 */
	beforeID?: string
	/**
	 * Hide the grid. @default false
	 */
	hidden?: boolean
}

export function GraticuleLayer({ beforeID, hidden = false }: GraticuleLayerProps): ReactNode {
	const data = useMemo(() => buildGraticule(), [])

	// Keep source and layer as siblings with an explicit source id.
	return (
		<>
			<Source id="mw-graticule" type="geojson" data={data} />
			<Layer
				id="mw-graticule-line"
				type="line"
				source="mw-graticule"
				{...(beforeID ? { beforeId: beforeID } : {})}
				layout={{ visibility: hidden ? "none" : "visible", "line-cap": "round" }}
				paint={{
					"line-color": "#8aa0c8",
					// Fade the grid as street-level tiles replace its orientation role.
					"line-opacity": ["interpolate", ["linear"], ["zoom"], 0, 0.3, 3, 0.2, 6, 0.09, 8, 0],
					"line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.5, 4, 0.75],
				}}
			/>
		</>
	)
}
