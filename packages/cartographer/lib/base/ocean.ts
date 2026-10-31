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
	return { type: "geojson", data: "https://public.mailwoman.ai/natural-earth/land-110m.json" }
}

/**
 * Colors of the sea floor by depth, from the shelf to the abyssal plain.
 *
 * Shallow water stays close to the water fill, so a coast reads as a pale band that deepens offshore.
 */
export const OceanPalette = {
	shelf: "#bcd7f2",
	slope: "#93bce6",
	deep: "#5f93cf",
	abyss: "#3a6aa8",
	trench: "#2a4f85",
	/**
	 * The color of the blurred line along the coast.
	 */
	coastGlow: "#eef6fd",
} as const

/**
 * The ocean's depth shading, drawn under the land fill.
 *
 * The terrain tiles include ETOPO1 bathymetry, so elevation below zero is the sea floor.
 * The bathymetry ends at z10 and is stretched beyond it, so its coastline misses reclaimed land.
 *
 * The land fill drawn over these layers decides the coast instead.
 * - `ocean-depth` colors the sea by depth with a `color-relief` layer.
 * - `ocean-floor` shades the sea floor's relief up to z7, where the land hillshade takes over.
 */
export const OceanFloorLayers: LayerSpecification[] = [
	{
		id: OceanLayerID("ocean-depth"),
		type: "color-relief",
		source: BathymetryTileSetID,
		paint: {
			"color-relief-opacity": 0.85,
			"color-relief-color": [
				"interpolate",
				["linear"],
				["elevation"],
				-8000,
				OceanPalette.trench,
				-4000,
				OceanPalette.abyss,
				-1500,
				OceanPalette.deep,
				-200,
				OceanPalette.slope,
				-20,
				OceanPalette.shelf,
				-1,
				GuideMapPalette.water,
			],
		},
	},
	{
		id: OceanLayerID("ocean-floor"),
		type: "hillshade",
		source: BathymetryTileSetID,
		maxzoom: 7,
		paint: {
			"hillshade-exaggeration": 0.35,
			"hillshade-shadow-color": OceanPalette.trench,
			"hillshade-highlight-color": "#ffffff",
			"hillshade-accent-color": OceanPalette.deep,
		},
	},
	// The basemap's land fill covers this layer once its tiles load.
	// At 1:110m the coast fills in bays such as Tokyo Bay, so the layer stops at globe scale.
	{
		id: OceanLayerID("land-underlay"),
		type: "fill",
		source: LandUnderlayTileSetID,
		maxzoom: LAND_UNDERLAY_MAX_ZOOM,
		paint: { "fill-color": GuideMapPalette.ground },
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
