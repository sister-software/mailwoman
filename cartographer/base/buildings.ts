/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type FillExtrusionLayerSpecification, type LayerSpecification } from "@maplibre/maplibre-gl-style-spec"
import { interpolateTurbo } from "d3-scale-chromatic"
import { LayerID } from "../styles/layers.js"
import { MailwomanBaseTileSetID } from "./theme.js"

const BuildingLayerID = LayerID.bind(null, "buildings")

/**
 * Layer definitions for building data.
 */
export const BuildingLayers: LayerSpecification[] = [
	createBuildingFillStyleLayer({
		id: BuildingLayerID("buildings-extruded"),

		paint: {
			"fill-extrusion-color": [
				// ---
				"interpolate",
				// ["exponential", 0.25],
				["linear"],
				[
					// --
					"coalesce",
					["get", "height"],
					["get", "minheight"],
					10,
				],
				...Array.from({ length: 10 }, (_, i) => {
					const sizeScalingFactor = 250 - 250 / i

					return [sizeScalingFactor, interpolateTurbo(sizeScalingFactor / 250)] as [number, string]
				}).flat(),
			],
			"fill-extrusion-translate": [0.1, 0.1],
		},
	}),

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
		minzoom: 12,
		paint: {
			...fillStyleSpec.paint,
			"fill-extrusion-vertical-gradient": true,

			"fill-extrusion-height": [
				"+",
				[
					// --
					"coalesce",
					["get", "height"],
					["get", "minheight"],
					10,
				],
				fillStyleSpec.heightOffset || 0,
			],
			"fill-extrusion-translate-anchor": "map",
			// "fill-extrusion-opacity": 0.7,
			"fill-extrusion-opacity": [
				// We fade out the outline at higher zoom levels
				"interpolate",
				["linear"],
				["zoom"],
				11,
				0.6,
				16,
				0.95,
			],
		},
	}

	return baseStyle
}
