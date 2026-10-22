/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type {
	ExpressionSpecification,
	FillExtrusionLayerSpecification,
	LayerSpecification,
} from "@maplibre/maplibre-gl-style-spec"

import { GuideMapPalette, MailwomanBaseTileSetID } from "#base/theme"
import { MAP_FONT_REGULAR } from "#styles/fonts"
import { LayerID } from "#styles/layers"

const BuildingLayerID = LayerID.bind(null, "buildings")

/**
 * Zoom where buildings start rising.
 */
const POP_START = 11
/**
 * Zoom where they reach full height.
 */
const POP_END = 12

/**
 * Building opacity by zoom, starting with the first zoom the tiles carry buildings.
 */
const buildingOpacity: ExpressionSpecification = ["interpolate", ["linear"], ["zoom"], 11, 0, 11.5, 0.6]
/**
 * Meters: tiny lift so the band clears the roof (kills z-fight)
 */
const ROOF_GAP = 0.1
/**
 * Meters: band thickness.
 */
const ROOF_CAP = 1

/**
 * Roof edge and footprint outline (縁取り).
 */
const BUILDING_EDGE = GuideMapPalette.buildingEdge

const buildingHeight = (offset = 0): ExpressionSpecification => [
	"+",
	["coalesce", ["get", "height"], ["get", "min_height"], 10],
	offset,
]

/**
 * Wrap a target-height expression in the zoom-driven pop interpolation.
 */
const popHeight = (target: ExpressionSpecification): ExpressionSpecification => [
	"interpolate",
	["linear"],
	["zoom"],
	POP_START,
	0,
	POP_END,
	target,
]

/**
 * Layer definitions for building data.
 */
export const BuildingLayers: LayerSpecification[] = [
	createBuildingFillStyleLayer({
		id: BuildingLayerID("buildings-extruded"),

		// Buildings are pale translucent volumes, so the streets and rail lines behind them stay legible.
		paint: {
			"fill-extrusion-color": GuideMapPalette.building,
			"fill-extrusion-vertical-gradient": false,
			"fill-extrusion-translate": [0.1, 0.1],
			"fill-extrusion-opacity": buildingOpacity,
		},
	}),

	// Roof-edge outline: thin extruded band sitting at the top of each building.
	{
		id: "basemap-buildings-roof-outline",
		type: "fill-extrusion",
		source: MailwomanBaseTileSetID,
		"source-layer": "buildings",
		minzoom: 10,
		paint: {
			"fill-extrusion-color": BUILDING_EDGE,

			"fill-extrusion-vertical-gradient": false,
			"fill-extrusion-translate-anchor": "map",
			"fill-extrusion-opacity": buildingOpacity,
			// top of the band = full building height "fill-extrusion-height": popHeight(buildingHeight()),
			// // base of the band = full height minus the cap thickness (clamped ≥ 0)
			// "fill-extrusion-base": popHeight([ "max", [ "-", buildingHeight(), ROOF_CAP ], 0 ]),
			"fill-extrusion-height": popHeight(["+", buildingHeight(), ROOF_GAP, ROOF_CAP]),
			"fill-extrusion-base": popHeight(["+", buildingHeight(), ROOF_GAP]),
		},
	},

	{
		id: "basemap-buildings-outline",
		type: "line",
		source: MailwomanBaseTileSetID,
		"source-layer": "buildings",
		minzoom: 14,
		paint: {
			"line-width": ["interpolate", ["linear"], ["zoom"], 14, 0.5, 18, 1],
			"line-color": BUILDING_EDGE,
			"line-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0, 15, 0.8],
		},
	},

	{
		id: "basemap-buildings-kind",
		type: "symbol",
		source: MailwomanBaseTileSetID,
		"source-layer": "buildings",
		minzoom: 11,
		layout: {
			visibility: "none",
			"text-field": ["to-string", ["id"]],
			"text-offset": [0, 0],
			"text-anchor": "center",
			"text-font": [MAP_FONT_REGULAR],
		},

		paint: {
			"text-color": "black",
			"text-halo-color": "red",
			"text-halo-width": 1,
		},
	},
]

type BuildingFillStyleSpec = Pick<FillExtrusionLayerSpecification, "id"> &
	Partial<FillExtrusionLayerSpecification> & {
		heightOffset?: number
	}

function createBuildingFillStyleLayer(fillStyleSpec: BuildingFillStyleSpec): LayerSpecification {
	const baseStyle: LayerSpecification = {
		...fillStyleSpec,
		type: "fill-extrusion",
		source: MailwomanBaseTileSetID,
		"source-layer": "buildings",
		minzoom: 10,
		paint: {
			"fill-extrusion-vertical-gradient": true,
			"fill-extrusion-height": popHeight(buildingHeight(fillStyleSpec.heightOffset)),
			// A building part, such as an upper section of a tower, starts at its `min_height` rather than the ground.
			"fill-extrusion-base": popHeight(["coalesce", ["get", "min_height"], 0]),
			"fill-extrusion-translate-anchor": "map",
			"fill-extrusion-opacity": 0.95,
			...fillStyleSpec.paint,
		},
	}

	return baseStyle
}
