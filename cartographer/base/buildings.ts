/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	type ExpressionSpecification,
	type FillExtrusionLayerSpecification,
	type LayerSpecification,
} from "@maplibre/maplibre-gl-style-spec"

import { LayerID } from "../styles/layers.ts"
import { MailwomanBaseTileSetID } from "./theme.ts"

const BuildingLayerID = LayerID.bind(null, "buildings")

const POP_START = 12.5 // zoom where buildings start rising
const POP_END = 13 // zoom where they reach full height (Protomaps fully loaded here)
const ROOF_GAP = 0.1 // meters: tiny lift so the band clears the roof (kills z-fight)
const ROOF_CAP = 1 // meters: band thickness

const buildingHeight = (offset = 0): ExpressionSpecification => [
	"+",
	["coalesce", ["get", "height"], ["get", "minheight"], 10],
	offset,
]

/** Wrap a target-height expression in the zoom-driven pop interpolation. */
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

		paint: {
			"fill-extrusion-color": "hsl(276.52deg 10.83% 10.31%)",
			"fill-extrusion-translate": [0.1, 0.1],
			"fill-extrusion-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0, 14.5, 1],
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
			// "fill-extrusion-color": "hsl(240deg 100% 80%)", // match footprint outline
			"fill-extrusion-color": "hsl(276.52deg 13% 12.31%)",

			"fill-extrusion-vertical-gradient": false,
			"fill-extrusion-translate-anchor": "map",
			"fill-extrusion-opacity": 1,
			// top of the band = full building height
			// "fill-extrusion-height": popHeight(buildingHeight()),
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
		minzoom: 11,
		filter: ["==", ["%", ["to-number", ["id"]], 2], 0],
		paint: {
			"line-width": 1,
			"line-color": "hsl(240deg 100% 80%)",
			"line-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0, 20, 1],
			"line-dasharray": [2, 3],
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
			"text-font": ["Fira Sans Regular"],
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
			...fillStyleSpec.paint,
			"fill-extrusion-vertical-gradient": true,
			"fill-extrusion-height": popHeight(buildingHeight(fillStyleSpec.heightOffset)),
			"fill-extrusion-base": 0,
			"fill-extrusion-translate-anchor": "map",
			"fill-extrusion-opacity": 0.95,
		},
	}

	return baseStyle
}
