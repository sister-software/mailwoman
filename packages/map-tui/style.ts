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

/**
 * Fields shared by every style entry. `featureKinds` scopes an entry to features whose `kind` tile attribute is in the
 * list; an entry without it is the layer's catch-all. Entries are consulted in table order and the first match wins, so
 * kind-scoped entries precede the catch-all.
 */
interface StyleBase {
	color: RGB
	minZoom: number
	featureKinds?: readonly string[]
}

export interface FillStyle extends StyleBase {
	kind: "fill"
}

export interface LineStyle extends StyleBase {
	kind: "line"
	width: (zoom: number) => number
}

export interface LabelStyle extends StyleBase {
	kind: "label"
	property: string
}

export type LayerStyle = FillStyle | LineStyle | LabelStyle

// Zoom level at which roads render with 2px width instead of 1px.
const ROAD_WIDTH_THRESHOLD = 14

const roadWidth = (zoom: number) => (zoom >= ROAD_WIDTH_THRESHOLD ? 2 : 1)

// At braille scale every road is one dot wide and every fill is stipple, so CLASS has to ride on color instead of
// geometry: arteries brighten toward amber, paths dim toward the vegetation green, and urban landuse runs warmer and
// brighter than vegetation so a city reads as denser texture. Luminance is load-bearing — asciify's ordered dither
// turns it into stipple density.
const VEGETATION_KINDS = [
	"allotments",
	"cemetery",
	"farmland",
	"forest",
	"garden",
	"grass",
	"meadow",
	"nature_reserve",
	"park",
	"scrub",
	"wetland",
	"wood",
] as const

const STYLE_TABLE: Record<string, LayerStyle[]> = {
	earth: [{ kind: "fill", color: [40, 44, 36], minZoom: 0 }],
	landcover: [{ kind: "fill", color: [36, 52, 32], minZoom: 4 }],
	landuse: [
		{ kind: "fill", color: [66, 60, 52], minZoom: 10, featureKinds: ["residential"] },
		{ kind: "fill", color: [72, 62, 50], minZoom: 10, featureKinds: ["commercial"] },
		{ kind: "fill", color: [58, 60, 64], minZoom: 10, featureKinds: ["industrial"] },
		{ kind: "fill", color: [36, 52, 32], minZoom: 10, featureKinds: VEGETATION_KINDS },
		{ kind: "fill", color: [48, 48, 40], minZoom: 10 },
	],
	water: [{ kind: "fill", color: [24, 48, 90], minZoom: 0 }],
	buildings: [{ kind: "fill", color: [70, 66, 60], minZoom: 13 }],
	boundaries: [{ kind: "line", color: [140, 110, 160], minZoom: 0, width: () => 1 }],
	roads: [
		{ kind: "line", color: [255, 190, 90], minZoom: 6, featureKinds: ["highway"], width: roadWidth },
		{ kind: "line", color: [215, 210, 180], minZoom: 6, featureKinds: ["major_road"], width: roadWidth },
		{ kind: "line", color: [185, 182, 158], minZoom: 6, featureKinds: ["medium_road"], width: roadWidth },
		{ kind: "line", color: [150, 150, 132], minZoom: 6, featureKinds: ["minor_road"], width: roadWidth },
		{ kind: "line", color: [105, 115, 98], minZoom: 6, featureKinds: ["path"], width: roadWidth },
		{ kind: "line", color: [115, 125, 140], minZoom: 6, featureKinds: ["rail"], width: () => 1 },
		{ kind: "line", color: [170, 170, 150], minZoom: 6, width: roadWidth },
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

/**
 * The one style painting a feature: the first entry whose `featureKinds` contains the feature's `kind` attribute, or
 * the first catch-all. A feature is painted at most once per draw pass — kind-scoped entries recolor, they never
 * double-paint.
 */
export function styleForFeatureKind(styles: readonly LayerStyle[], featureKind: unknown): LayerStyle | null {
	for (const style of styles) {
		if (style.featureKinds == null) return style

		if (typeof featureKind === "string" && style.featureKinds.includes(featureKind)) return style
	}

	return null
}
