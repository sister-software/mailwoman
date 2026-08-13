/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * Protomaps-basemap style table for the map-tui debug view.
 *
 * Defines fill, line, and label styles for each of the nine protomaps-basemap layers, gated by zoom level. Color
 * palette calibrated for dark-terminal rendering: dim fills (read as stipple density via dithering), bright lines and
 * labels.
 */

export type RGB = readonly [red: number, green: number, blue: number]

export interface FillStyle {
	kind: "fill"
	color: RGB
	minZoom: number
}

export interface LineStyle {
	kind: "line"
	color: RGB
	minZoom: number
	width: (zoom: number) => number
}

export interface LabelStyle {
	kind: "label"
	color: RGB
	minZoom: number
	property: string
}

export type LayerStyle = FillStyle | LineStyle | LabelStyle

// Zoom level at which roads render with 2px width instead of 1px.
const ROAD_WIDTH_THRESHOLD = 14

const STYLE_TABLE: Record<string, LayerStyle[]> = {
	earth: [{ kind: "fill", color: [40, 44, 36], minZoom: 0 }],
	landcover: [{ kind: "fill", color: [36, 52, 32], minZoom: 4 }],
	landuse: [{ kind: "fill", color: [48, 48, 40], minZoom: 10 }],
	water: [{ kind: "fill", color: [24, 48, 90], minZoom: 0 }],
	buildings: [{ kind: "fill", color: [70, 66, 60], minZoom: 13 }],
	boundaries: [{ kind: "line", color: [140, 110, 160], minZoom: 0, width: () => 1 }],
	roads: [
		{ kind: "line", color: [170, 170, 150], minZoom: 6, width: (zoom) => (zoom >= ROAD_WIDTH_THRESHOLD ? 2 : 1) },
	],
	places: [{ kind: "label", color: [235, 235, 220], minZoom: 2, property: "name" }],
	pois: [{ kind: "label", color: [180, 200, 160], minZoom: 14, property: "name" }],
}

/**
 * Styles applying to a protomaps-basemap layer at a zoom, draw-ordered (fills < lines < labels). Empty for
 * unstyled/gated layers.
 */
export function stylesFor(layerName: string, zoom: number): LayerStyle[] {
	return (STYLE_TABLE[layerName] ?? []).filter((style) => zoom >= style.minZoom)
}
