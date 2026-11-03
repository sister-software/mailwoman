/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { GeoJSONSourceSpecification, LayerSpecification } from "@maplibre/maplibre-gl-style-spec"

import { BathymetryTileSetID } from "#base/terrain"
import { GuideMapPalette, MailwomanBaseTileSetID } from "#base/theme"
import { LayerID } from "#styles/layers"
import { TileSetSourceID } from "#styles/sources"

const OceanLayerID = LayerID.bind(null, MailwomanBaseTileSetID)

/**
 * Identifier for the coarse land source drawn while basemap tiles load.
 */
export const LandUnderlayTileSetID = TileSetSourceID("land-underlay")

/**
 * The zoom at which the coarse land layer stops drawing.
 */
const LAND_UNDERLAY_MAX_ZOOM = 6

/**
 * Creates the coarse land source: Natural Earth's 1:110m land polygons, rounded to two decimal places.
 *
 * The file is 87 KB, so it arrives before the basemap tiles and the globe shows
 * its continents from the first frame.
 */
export function createLandUnderlaySource(): GeoJSONSourceSpecification {
	return { type: "geojson", data: "https://public.mailwoman.post/natural-earth/land-110m.json" }
}

/**
 * Colors of the sea by depth, from the shelf to the trenches.
 *
 * The sea is a tropical blue that darkens with depth, as water does when it is deep.
 */
export const OceanPalette = {
	/**
	 * The ocean fill: water over the continental shelf, down to about 100 m.
	 */
	shelf: "#8fdaf7",
	slope: "#5cc4f2",
	deep: "#35ace8",
	abyss: "#2396de",
	trench: "#1679c9",
	/**
	 * The color of the blurred line along the coast.
	 */
	coastGlow: "#d6f4fd",
} as const

/**
 * The depth below which the depth shading starts to darken the ocean fill, in meters.
 *
 * The bathymetry is ETOPO1 at about 1.8 km per sample, so a sample on a coast can read
 * below sea level over land: a reclaimed shore, or a narrow headland.
 * The depth shading draws over the land fill, so it stays transparent down to this depth.
 * A coastal sample rarely reads this deep.
 */
const DEPTH_SHADING_START_M = -100

/**
 * The land fill drawn under the basemap's land while its tiles load, at globe zoom.
 *
 * The basemap's land fill covers this layer once its tiles load.
 * At 1:110m the coast fills in bays such as Tokyo Bay, so the layer stops at globe scale.
 *
 * It is lawn green because at that scale the land cover over it is mostly vegetation.
 */
export const LandUnderlayLayers: LayerSpecification[] = [
	{
		id: OceanLayerID("land-underlay"),
		type: "fill",
		source: LandUnderlayTileSetID,
		maxzoom: LAND_UNDERLAY_MAX_ZOOM,
		paint: { "fill-color": GuideMapPalette.lawn },
	},
]

/**
 * The ocean, drawn over the land layers.
 *
 * - `ocean-fill` is opaque, so a land-use polygon or boundary that runs out to sea is hidden under it.
 *   Marine reserves and city limits drawn in OSM over the water are two such cases.
 * - `ocean-depth` darkens the fill by depth with a `color-relief` layer over the
 *   ETOPO1 bathymetry in the terrain tiles.
 *   The bathymetry ends at z10 and is stretched beyond it.
 *   The shading is a smooth gradient, without relief shading, so the sea floor reads as depth of water.
 */
export const OceanLayers: LayerSpecification[] = [
	{
		id: OceanLayerID("ocean-fill"),
		type: "fill",
		source: MailwomanBaseTileSetID,
		"source-layer": "water",
		filter: ["==", ["get", "kind"], "ocean"],
		paint: { "fill-color": OceanPalette.shelf },
	},
	{
		id: OceanLayerID("ocean-depth"),
		type: "color-relief",
		source: BathymetryTileSetID,
		paint: {
			"color-relief-color": [
				"interpolate",
				["linear"],
				["elevation"],
				-9000,
				OceanPalette.trench,
				-4000,
				OceanPalette.abyss,
				-1500,
				OceanPalette.deep,
				-400,
				OceanPalette.slope,
				DEPTH_SHADING_START_M,
				"rgba(143, 218, 247, 0)",
			],
		},
	},
]

/**
 * The pale blurred line along the ocean's edge, drawn over the water fill.
 */
export const OceanCoastLayers: LayerSpecification[] = [
	{
		id: OceanLayerID("ocean-coast-glow"),
		type: "line",
		source: MailwomanBaseTileSetID,
		"source-layer": "water",
		filter: ["==", ["get", "kind"], "ocean"],
		paint: {
			"line-color": OceanPalette.coastGlow,
			"line-opacity": 0.7,
			"line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 4, 2, 10, 6, 15, 14],
			"line-blur": ["interpolate", ["exponential", 1.5], ["zoom"], 4, 2, 10, 6, 15, 12],
		},
	},
]
