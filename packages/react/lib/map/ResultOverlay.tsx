/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Tokens } from "@sister.software/theme"
import type { ReactNode } from "react"
import { Layer, Source } from "react-map-gl/maplibre"

import type { PlaceGeometry } from "#map/geometry"

/**
 * The brand's selection accent, matched to {@link PlaceMarker}.
 *
 * MapLibre paint takes a literal colour, so it is read from the theme's data rather than a custom property.
 */
const OUTLINE_COLOR = Tokens.resolve("color.cyan-electric")

export interface ResultOverlayProps {
	/**
	 * The outline geometry to draw, or `null` to draw no geometry (the bare-point result).
	 */
	outline: PlaceGeometry | null
	/**
	 * Source/layer id prefix — override to render more than one outline on a map.
	 *
	 * @defaultValue `"mw-result"`
	 */
	id?: string
	/**
	 * Fill color.
	 *
	 * @defaultValue the house pink.
	 */
	color?: string
	/**
	 * Fill opacity.
	 *
	 * @defaultValue `0.12`
	 */
	fillOpacity?: number
	/**
	 * Outline stroke width (px).
	 *
	 * @defaultValue `2`
	 */
	lineWidth?: number
}

/**
 * Render the resolved-place outline.
 */
export function ResultOverlay({
	outline,
	id = "mw-result",
	color = OUTLINE_COLOR,
	fillOpacity = 0.12,
	lineWidth = 2,
}: ResultOverlayProps): ReactNode {
	if (!outline) return null

	const data = {
		type: "FeatureCollection" as const,
		features: [{ type: "Feature" as const, geometry: outline, properties: {} }],
	}

	return (
		<Source id={id} type="geojson" data={data}>
			<Layer id={`${id}-fill`} type="fill" paint={{ "fill-color": color, "fill-opacity": fillOpacity }} />
			<Layer id={`${id}-line`} type="line" paint={{ "line-color": color, "line-width": lineWidth }} />
		</Source>
	)
}
