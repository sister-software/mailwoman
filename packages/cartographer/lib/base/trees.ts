/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { LayerSpecification } from "@maplibre/maplibre-gl-style-spec"

import { MailwomanBaseTileSetID } from "#base/theme"
import { LayerID } from "#styles/layers"

/**
 * Colors of extruded trees.
 *
 * Broad-leaved crowns are a lighter green than needle-leaved ones, as on Japanese park maps.
 */
export const TreePalette = {
	trunk: "#8a6d55",
	crown: "#8fc46e",
	needleCrown: "#6ea65a",
} as const

const TreeLayerID = LayerID.bind(null, MailwomanBaseTileSetID)

/**
 * Trees from the `trees` source layer of the mailwoman/basemaps build.
 *
 * Each tree is a trunk and a crown polygon with `min_height` and `height` in meters.
 * The tiles carry them at z15, and the map overzooms them above that.
 *
 * They fade in over z15–16, where a crown first covers a few pixels.
 */
export const TreeLayers: LayerSpecification[] = [
	{
		id: TreeLayerID("tree-trunks"),
		type: "fill-extrusion",
		source: MailwomanBaseTileSetID,
		"source-layer": "trees",
		minzoom: 16,
		filter: ["==", ["get", "kind"], "trunk"],
		paint: {
			"fill-extrusion-color": TreePalette.trunk,
			"fill-extrusion-height": ["get", "height"],
			"fill-extrusion-base": ["get", "min_height"],
			"fill-extrusion-opacity": ["interpolate", ["linear"], ["zoom"], 16, 0, 16.5, 1],
		},
	},
	{
		id: TreeLayerID("tree-crowns"),
		type: "fill-extrusion",
		source: MailwomanBaseTileSetID,
		"source-layer": "trees",
		minzoom: 15,
		filter: ["==", ["get", "kind"], "crown"],
		paint: {
			"fill-extrusion-color": [
				"match",
				["get", "leaf_type"],
				"needleleaved",
				TreePalette.needleCrown,
				TreePalette.crown,
			],
			"fill-extrusion-height": ["get", "height"],
			"fill-extrusion-base": ["get", "min_height"],
			"fill-extrusion-opacity": ["interpolate", ["linear"], ["zoom"], 15, 0, 16, 0.9],
			// The gradient darkens the lower crown, which reads as shading under the leaves.
			"fill-extrusion-vertical-gradient": true,
		},
	},
]
