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
 *
 * Blocks stay translucent while they are small, so streets read through them,
 * and become nearly opaque by z15.
 * At 0.6 a tall tower seen at street zoom showed the map through its walls.
 */
const buildingOpacity: ExpressionSpecification = ["interpolate", ["linear"], ["zoom"], 11, 0, 11.5, 0.6, 15, 0.9]

/**
 * The height in meters given to a building or part whose tags state no height.
 */
const UNKNOWN_BUILDING_HEIGHT = 10

/**
 * Roof edge and footprint outline (縁取り).
 */
const BUILDING_EDGE = GuideMapPalette.buildingEdge

/**
 * A feature's top in meters.
 *
 * A part with a `min_height` and no height rises the default height above its base.
 */
const buildingHeight = (offset = 0): ExpressionSpecification => [
	"+",
	["coalesce", ["get", "height"], ["+", ["coalesce", ["get", "min_height"], 0], UNKNOWN_BUILDING_HEIGHT]],
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
 * How far a tagged facade or roof color moves the building color from the base tint, from 0 to 1.
 *
 * An OSM color can be a saturated name such as `red`.
 * At full strength it would read as signage on the pale map.
 */
const TAGGED_COLOR_WEIGHT = 0.5

/**
 * A tagged `#rrggbb` color mixed toward the base building color in Lab space.
 */
const taggedColor = (key: "facade_color" | "roof_color"): ExpressionSpecification => [
	"interpolate-lab",
	["linear"],
	TAGGED_COLOR_WEIGHT,
	0,
	GuideMapPalette.building,
	1,
	["to-color", ["get", key]],
]

/**
 * The tint for a building's `district` index, or the base building color when the tile has no index.
 *
 * The tuple type requires at least one branch, so index 0's branch is written out
 * and the rest are spread after it.
 */
function districtTint(): ExpressionSpecification {
	const [first, ...rest] = GuideMapPalette.buildingDistricts
	const branches = rest.flatMap((tint, index) => [index + 1, tint])

	return [
		"match",
		["to-number", ["coalesce", ["get", "district"], -1]],
		0,
		first,
		...branches,
		GuideMapPalette.building,
	]
}

/**
 * A building's extrusion color.
 *
 * The tagged facade color comes first, then the roof color.
 * A building with neither takes its district tint, and a tile built before districts
 * existed falls back to the base building color.
 */
export const buildingColor: ExpressionSpecification = [
	"case",
	["has", "facade_color"],
	taggedColor("facade_color"),
	["has", "roof_color"],
	taggedColor("roof_color"),
	districtTint(),
]

/**
 * The feature-state key a viewer sets on a footprint that a finer 3D model draws in its place.
 *
 * A footprint with this state set extrudes to zero height and drops its outline.
 */
export const BUILDING_MODELED_STATE = "modeled"

const isModeled: ExpressionSpecification = ["boolean", ["feature-state", BUILDING_MODELED_STATE], false]

/**
 * Layer definitions for building data.
 */
export const BuildingLayers: LayerSpecification[] = [
	createBuildingFillStyleLayer({
		id: BuildingLayerID("buildings-extruded"),

		// Buildings are pale translucent volumes, so the streets and rail lines behind them stay legible.
		paint: {
			"fill-extrusion-color": buildingColor,
			"fill-extrusion-vertical-gradient": false,
			"fill-extrusion-opacity": buildingOpacity,
		},
	}),

	{
		id: "basemap-buildings-outline",
		type: "line",
		source: MailwomanBaseTileSetID,
		"source-layer": "buildings",
		minzoom: 14,
		paint: {
			"line-width": ["interpolate", ["linear"], ["zoom"], 14, 0.5, 18, 1],
			"line-color": BUILDING_EDGE,
			"line-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0, 15, ["case", isModeled, 0, 0.8]],
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
			"fill-extrusion-height": popHeight(["case", isModeled, 0, buildingHeight(fillStyleSpec.heightOffset)]),
			// A building part, such as an upper section of a tower, starts at its `min_height`.
			"fill-extrusion-base": popHeight(["case", isModeled, 0, ["coalesce", ["get", "min_height"], 0]]),
			"fill-extrusion-translate-anchor": "map",
			"fill-extrusion-opacity": 0.95,
			...fillStyleSpec.paint,
		},
	}

	return baseStyle
}
