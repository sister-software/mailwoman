/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { LayerSpecification } from "@maplibre/maplibre-gl-style-spec"

import { BathymetryTileSetID } from "#base/terrain"
import { GuideMapPalette, MailwomanBaseTileSetID } from "#base/theme"
import { LayerID } from "#styles/layers"

const OceanLayerID = LayerID.bind(null, MailwomanBaseTileSetID)

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
 * The ocean's depth shading, drawn over the water fill.
 *
 * The terrain tiles carry bathymetry from ETOPO1, so elevation below zero is the sea floor.
 * - `ocean-depth` colors the water by depth with a `color-relief` layer.
 *   It is transparent at zero and above, so land and inland water keep their own fills.
 * - `ocean-floor` shades the sea floor's relief up to z7, where the land hillshade takes over.
 * - `ocean-coast-glow` draws a pale blurred line along the ocean's edge.
 */
export const OceanLayers: LayerSpecification[] = [
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
				0,
				"rgba(0, 0, 0, 0)",
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
