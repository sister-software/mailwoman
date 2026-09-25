/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Draws a grid of meridians and parallels under the basemap so that the globe is readable while
 *   tiles load. Loaded tiles cover the grid.
 */

import { type ReactNode, useMemo } from "react"
import { Layer, Source } from "react-map-gl/maplibre"

import { buildGraticule } from "./graticule.ts"

/**
 * Props for {@link GraticuleLayer}.
 */
export interface GraticuleLayerProps {
	/**
	 * The basemap layer to draw the grid beneath.
	 * Without it, the grid is drawn on top.
	 */
	beforeID?: string
	/**
	 * Hides the grid. @default false
	 */
	hidden?: boolean
}

/**
 * Renders the graticule source and line layer.
 */
export function GraticuleLayer({ beforeID, hidden = false }: GraticuleLayerProps): ReactNode {
	const data = useMemo(() => buildGraticule(), [])

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
					// The grid fades out by zoom 8, where map detail makes it unnecessary.
					"line-opacity": ["interpolate", ["linear"], ["zoom"], 0, 0.3, 3, 0.2, 6, 0.09, 8, 0],
					"line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.5, 4, 0.75],
				}}
			/>
		</>
	)
}
