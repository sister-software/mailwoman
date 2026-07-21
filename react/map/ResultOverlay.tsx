/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<ResultOverlay>` — the resolved-place outline (crisp admin polygon, or an approximate/exact-radius
 *   circle) as a declarative `<Source>` + fill/line `<Layer>`s. This replaces the demo's imperative
 *   `setPlaceOutline` / `drawApproxCircle` / `drawPlaceGeometry` / `clearBbox` helpers and their
 *   `whenStyleReady` gate: react-map-gl owns the "add source/layer once the style is loaded, remove on
 *   unmount" lifecycle, so the hand-rolled `isStyleLoaded()` / `styledata` races disappear.
 *
 *   Pass the `outline` straight from a {@link MapPlaceRenderSpec}; a `null` outline renders nothing (the
 *   bare-point case). NODE-IMPORT SAFETY: imports `react-map-gl/maplibre` — `@mailwoman/react/map` only.
 */

import type { ReactNode } from "react"
import { Layer, Source } from "react-map-gl/maplibre"

import type { PlaceGeometry } from "./geometry.ts"

/** The house pink, matched to {@link PlaceMarker}. */
const OUTLINE_COLOR = "#e0367c"

export interface ResultOverlayProps {
	/** The outline geometry to draw, or `null` to draw nothing (the bare-point result). */
	outline: PlaceGeometry | null
	/** Source/layer id prefix — override to render more than one outline on a map. @default "mw-result" */
	id?: string
	/** Fill color. @default the house pink. */
	color?: string
	/** Fill opacity. @default 0.12 */
	fillOpacity?: number
	/** Outline stroke width (px). @default 2 */
	lineWidth?: number
}

/**
 * Render the resolved-place outline. One geojson `<Source>` feeds a translucent fill `<Layer>` and a solid line
 * `<Layer>` — the same two layers the imperative `setPlaceOutline` created, now declarative and self-cleaning.
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
