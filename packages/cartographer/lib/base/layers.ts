/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { layers } from "@protomaps/basemaps"
import type { ExpressionSpecification, LayerSpecification } from "maplibre-gl"

import { BuildingLayers } from "#base/buildings"
import { InfrastructureLayers } from "#base/infrastructure"
import { HillshadeTileSetID } from "#base/terrain"
import { GuideMapPalette, MailwomanBaseFlavor, MailwomanBaseTileSetID } from "#base/theme"
import { TreeLayers } from "#base/trees"
import { MAP_FONT_REGULAR } from "#styles/fonts"
import { LayerID } from "#styles/layers"

/**
 * Layer id for the hillshade raster, referenced by style definitions that draw terrain beneath the base map.
 */
export const HillsLayerID = LayerID(HillshadeTileSetID, "hills")

/**
 * Splits `layers()` into non-label and label groups.
 *
 * The interval between base geometry and labels holds the footprints.
 * It also holds water outlines and hillshade.
 *
 * `@protomaps/basemaps@5.x` doesn't expose a `noLabels` helper.
 * `labelsOnly: true` gives only the label layers.
 *
 * The full list minus that set yields the non-label group.
 */
const allBaseLayers = layers(MailwomanBaseTileSetID, MailwomanBaseFlavor, { lang: "en" })
const labelLayers = layers(MailwomanBaseTileSetID, MailwomanBaseFlavor, { lang: "en", labelsOnly: true })
const labelLayerIDs = new Set(labelLayers.map((layer) => layer.id))

/**
 * Major-road color by administrative class.
 *
 * Protomaps files national and prefectural roads under one `major_road` kind
 * and keeps the OSM class in `kind_detail`.
 * In Japanese OSM data, national routes are tagged `trunk` or `primary` and prefectural
 * roads `secondary` or `tertiary`, so the class picks orange or yellow.
 */
const isPrefecturalRoad: ExpressionSpecification = [
	"any",
	["==", ["get", "kind_detail"], "secondary"],
	// A `tertiary` road is a prefectural road only when it carries a route number.
	// Unnumbered `tertiary` roads are municipal and draw as white streets.
	["all", ["==", ["get", "kind_detail"], "tertiary"], ["has", "ref"]],
]

const majorRoadColor: ExpressionSpecification = [
	"case",
	["in", ["get", "kind_detail"], ["literal", ["trunk", "primary"]]],
	GuideMapPalette.nationalRoad,
	isPrefecturalRoad,
	GuideMapPalette.prefecturalRoad,
	GuideMapPalette.road,
]

/**
 * Edge color of a major road: the flavor's edge for a classed road,
 * and none for a municipal road drawn white.
 */
const majorRoadEdge = (edge: unknown): ExpressionSpecification => [
	"case",
	["any", ["in", ["get", "kind_detail"], ["literal", ["trunk", "primary"]]], isPrefecturalRoad],
	edge as string,
	"rgba(0, 0, 0, 0)",
]

const MAJOR_CASING_LAYER_IDS = new Set([
	"roads_major_casing_late",
	"roads_major_casing_early",
	"roads_bridges_major_casing",
	"roads_tunnels_major_casing",
])

/**
 * Surface railway width.
 *
 * The hatched line is widest at city zoom, where a line stands for a whole route.
 * At street zoom each track is its own feature, so the line thins to a single track.
 */
const railWidth: ExpressionSpecification = ["interpolate", ["linear"], ["zoom"], 9, 1, 12, 2.5, 14, 3, 15, 1.5, 18, 1.5]

/**
 * Zoom above which surface track draws as a plain thin line rather than a hatched route line.
 */
const RAIL_HATCH_MAXZOOM = 15

const MAJOR_ROAD_LAYER_IDS = new Set(["roads_major", "roads_bridges_major", "roads_tunnels_major"])

/**
 * Edges of streets below the major class.
 *
 * Minor streets are white lines on the ground color with no edge at any zoom.
 * The contrast between white street and gray block draws the block shape.
 */
const MINOR_EDGE_LAYER_IDS = new Set([
	"roads_minor_casing",
	"roads_minor_service_casing",
	"roads_bridges_minor_casing",
	"roads_bridges_other_casing",
	"roads_tunnels_minor_casing",
	"roads_tunnels_other_casing",
])

/**
 * Footpaths and narrow lanes, which a street map leaves out until the blocks are large enough to hold them.
 */
const PATH_LAYER_IDS = new Set(["roads_other", "roads_bridges_other", "roads_tunnels_other"])

const pathOpacity: ExpressionSpecification = ["interpolate", ["linear"], ["zoom"], 13, 0, 15, 1]

/**
 * Rewrites the Protomaps layers whose Japanese treatment needs more than one flavor color.
 */
/**
 * Land-use kinds the Protomaps styles leave undrawn: sports grounds, gardens and rice paddies.
 *
 * Drawn directly above the park fill, so a pitch or track inside a park sits on top of it.
 */
const GuideMapLanduseLayer: LayerSpecification = {
	id: "landuse_guide_map",
	type: "fill",
	source: MailwomanBaseTileSetID,
	"source-layer": "landuse",
	filter: ["in", ["get", "kind"], ["literal", ["sports_centre", "stadium", "garden", "paddy", "pitch", "track"]]],
	paint: {
		"fill-color": [
			"match",
			["get", "kind"],
			["sports_centre", "stadium"],
			GuideMapPalette.sportsGround,
			"garden",
			GuideMapPalette.lawn,
			"paddy",
			GuideMapPalette.paddy,
			"pitch",
			GuideMapPalette.pitch,
			GuideMapPalette.track,
		],
		"fill-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0, 12, 1],
	},
	// Grounds draw first, then tracks, then the pitches inside them.
	layout: {
		"fill-sort-key": ["match", ["get", "kind"], ["sports_centre", "stadium", "paddy", "garden"], 0, "track", 1, 2],
	},
}

function toGuideMapLayers(source: LayerSpecification): LayerSpecification[] {
	if (source.id === "landuse_park") return [source, GuideMapLanduseLayer]

	if (source.type !== "line") return [source]

	// Protomaps leaves the join at the miter default, which draws road corners and bends as sharp points.
	const layer: typeof source = source.id.startsWith("roads_")
		? { ...source, layout: { ...source.layout, "line-join": "round", "line-cap": "round" } }
		: source

	if (MAJOR_ROAD_LAYER_IDS.has(layer.id)) {
		return [{ ...layer, paint: { ...layer.paint, "line-color": majorRoadColor } }]
	}

	if (MAJOR_CASING_LAYER_IDS.has(layer.id)) {
		return [{ ...layer, paint: { ...layer.paint, "line-color": majorRoadEdge(layer.paint?.["line-color"]) } }]
	}

	if (PATH_LAYER_IDS.has(layer.id)) {
		return [{ ...layer, paint: { ...layer.paint, "line-opacity": pathOpacity } }]
	}

	if (MINOR_EDGE_LAYER_IDS.has(layer.id)) {
		return [{ ...layer, layout: { ...layer.layout, visibility: "none" } }]
	}

	if (layer.id === "roads_rail") {
		// A Japanese railway is a dark line hatched with white dashes.
		// Track in a tunnel is a thin red dashed line at reduced opacity, drawn over the streets above it.
		const surface: ExpressionSpecification = ["all", ["==", ["get", "kind"], "rail"], ["!", ["has", "is_tunnel"]]]
		const tunnel: ExpressionSpecification = ["all", ["==", ["get", "kind"], "rail"], ["has", "is_tunnel"]]

		return [
			{
				...layer,
				filter: surface,
				paint: { "line-color": GuideMapPalette.railway, "line-width": railWidth },
			},
			{
				...layer,
				id: "roads_rail_hatch",
				minzoom: 11,
				maxzoom: RAIL_HATCH_MAXZOOM,
				filter: surface,
				paint: {
					"line-color": "#ffffff",
					"line-width": ["interpolate", ["linear"], ["zoom"], 11, 1, 14, 1.6],
					"line-dasharray": [3, 3],
				},
			},
			{
				...layer,
				id: "roads_rail_tunnel",
				minzoom: 12,
				filter: tunnel,
				paint: {
					"line-color": GuideMapPalette.subway,
					"line-opacity": 0.6,
					"line-width": ["interpolate", ["linear"], ["zoom"], 12, 1, 18, 2],
					"line-dasharray": [4, 3],
				},
			},
		]
	}

	if (layer.id === "boundaries") {
		// A municipal boundary is a translucent red band under a dark dash-dot line.
		return [
			{
				...layer,
				id: "boundaries_band",
				paint: {
					"line-color": GuideMapPalette.boundaryBand,
					"line-opacity": 0.35,
					"line-width": ["interpolate", ["linear"], ["zoom"], 5, 0, 11, 3, 15, 5, 18, 8],
				},
			},
			{
				...layer,
				paint: {
					"line-color": GuideMapPalette.boundaryLine,
					"line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.5, 16, 1.5],
					"line-dasharray": [6, 2, 1.5, 2],
				},
			},
		]
	}

	return [layer]
}

const nonLabelLayers = allBaseLayers.filter((layer) => !labelLayerIDs.has(layer.id)).flatMap(toGuideMapLayers)

/**
 * Rewrites the Protomaps label layers for the guide map.
 *
 * House numbers appear from street zoom in an upright face, where Protomaps
 * shows them only at z18 in italic.
 */
function toGuideMapLabel(layer: LayerSpecification): LayerSpecification {
	if (layer.id !== "address_label" || layer.type !== "symbol") return layer

	return {
		...layer,
		minzoom: 16,
		layout: {
			...layer.layout,
			// A Japanese address point often carries only its block number (番地).
			"text-field": ["coalesce", ["get", "addr_housenumber"], ["get", "addr_block_number"]],
			"text-font": [MAP_FONT_REGULAR],
			"text-size": ["interpolate", ["linear"], ["zoom"], 16, 9, 18, 12],
		},
	}
}

/**
 * One-way arrows (一方通行), drawn along the street in the direction of travel.
 *
 * OSM draws a one-way way in its direction of travel, so an arrow placed along
 * the line points the right way.
 */
const OneWayArrowLayer: LayerSpecification = {
	id: LayerID(MailwomanBaseTileSetID, "oneway-arrows"),
	type: "symbol",
	source: MailwomanBaseTileSetID,
	"source-layer": "roads",
	minzoom: 16,
	filter: ["all", ["==", ["get", "oneway"], "yes"], ["!=", ["get", "kind"], "path"]],
	layout: {
		"symbol-placement": "line",
		"symbol-spacing": 120,
		"text-field": "→",
		"text-font": [MAP_FONT_REGULAR],
		"text-size": ["interpolate", ["linear"], ["zoom"], 16, 10, 19, 14],
		"text-keep-upright": false,
		"text-rotation-alignment": "map",
	},
	paint: {
		"text-color": GuideMapPalette.oneway,
	},
}

/**
 * The base map's layer stack, in draw order — terrain, then land cover, then water, then boundaries.
 */
export const BaseLayers: LayerSpecification[] = [
	...nonLabelLayers,
	{
		id: LayerID(MailwomanBaseTileSetID, "water-outline"),
		type: "line",
		source: MailwomanBaseTileSetID,
		"source-layer": "water",
		filter: ["any", ["in", "water", "river", "lake", "other"]],
		paint: {
			"line-color": GuideMapPalette.waterEdge,
			"line-width": 1,
		},
	},
	{
		id: HillsLayerID,
		type: "hillshade",
		source: HillshadeTileSetID,
		minzoom: 7,
		// Street maps shade terrain at regional zoom and leave the city ground flat.
		maxzoom: 13,
		paint: {
			"hillshade-exaggeration": 0.15,
			"hillshade-accent-color": "#8a908c",
			"hillshade-shadow-color": "#5c625e",
			"hillshade-highlight-color": "#ffffff",
		},
	},
	...InfrastructureLayers,
	...BuildingLayers,
	...TreeLayers,
	OneWayArrowLayer,
	...labelLayers.map(toGuideMapLabel),
]
