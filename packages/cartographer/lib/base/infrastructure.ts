/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { ExpressionSpecification, LayerSpecification } from "@maplibre/maplibre-gl-style-spec"

import { GuideMapPalette, MailwomanBaseTileSetID } from "#base/theme"
import { LayerID } from "#styles/layers"

/**
 * Colors of utility networks, barriers and street furniture.
 *
 * Japanese street maps draw these in low contrast: thin gray lines for power
 * and walls, and small colored marks for hydrants (消火栓) and fire cisterns (防火水槽),
 * which fire and utility maps show in red and blue.
 */
export const InfrastructurePalette = {
	power: "#8c8c8c",
	telecom: "#7a86a8",
	waterNetwork: "#7fa3d6",
	wall: "#a39b90",
	fence: "#bdb6aa",
	hedge: "#8fbf6f",
	treeRow: "#7fb05e",
	embankment: "#c2b8a3",
	hydrant: "#e0473b",
	cistern: "#3d7fd6",
	defibrillator: "#2f9e5b",
	structure: "#e6e2d8",
	/**
	 * Japanese post boxes are red.
	 */
	postBox: "#d6312b",
	signal: "#e3a019",
	streetLamp: "#c9b458",
	furniture: "#9a7b5f",
	kerb: "#b4afa5",
	crosswalk: "#ffffff",
	bikeLane: "#3a8fd6",
} as const

const InfrastructureLayerID = LayerID.bind(null, MailwomanBaseTileSetID)

const kindIs = (kind: string): ExpressionSpecification => ["==", ["get", "kind"], kind]
const detailIn = (...details: string[]): ExpressionSpecification => ["in", ["get", "kind_detail"], ["literal", details]]
const isLine: ExpressionSpecification = ["==", ["geometry-type"], "LineString"]
const isPoint: ExpressionSpecification = ["==", ["geometry-type"], "Point"]
const isArea: ExpressionSpecification = ["==", ["geometry-type"], "Polygon"]

const base = {
	source: MailwomanBaseTileSetID,
	"source-layer": "infrastructure",
} as const

/**
 * Layers for the `infrastructure` source layer of the mailwoman/basemaps build.
 *
 * Areas draw under buildings, lines above them at street zoom, and point marks last
 * so a hydrant on a sidewalk stays visible.
 */
export const InfrastructureLayers: LayerSpecification[] = [
	{
		...base,
		id: InfrastructureLayerID("infrastructure-areas"),
		type: "fill",
		minzoom: 13,
		filter: ["all", isArea, ["in", ["get", "kind"], ["literal", ["power", "water", "telecom", "man_made"]]]],
		paint: {
			"fill-color": InfrastructurePalette.structure,
			"fill-outline-color": GuideMapPalette.buildingEdge,
		},
	},
	{
		...base,
		id: InfrastructureLayerID("infrastructure-embankments"),
		type: "line",
		minzoom: 15,
		filter: ["all", isLine, kindIs("man_made"), detailIn("embankment")],
		paint: {
			"line-color": InfrastructurePalette.embankment,
			"line-width": ["interpolate", ["linear"], ["zoom"], 15, 1, 18, 3],
		},
	},
	{
		...base,
		id: InfrastructureLayerID("infrastructure-hedges"),
		type: "line",
		minzoom: 16,
		filter: ["any", ["all", isLine, kindIs("barrier"), detailIn("hedge")], ["all", isLine, kindIs("natural")]],
		layout: { "line-cap": "round", "line-join": "round" },
		paint: {
			"line-color": ["match", ["get", "kind"], "natural", InfrastructurePalette.treeRow, InfrastructurePalette.hedge],
			"line-width": ["interpolate", ["linear"], ["zoom"], 16, 1.5, 19, 4],
			// A tree row reads as a chain of crowns.
			"line-dasharray": [0.5, 1.5],
		},
	},
	{
		...base,
		id: InfrastructureLayerID("infrastructure-walls"),
		type: "line",
		minzoom: 16,
		filter: ["all", isLine, kindIs("barrier"), detailIn("fence", "wall", "retaining_wall")],
		paint: {
			"line-color": ["match", ["get", "kind_detail"], "fence", InfrastructurePalette.fence, InfrastructurePalette.wall],
			"line-width": ["interpolate", ["linear"], ["zoom"], 16, 0.5, 19, 1.5],
		},
	},
	{
		...base,
		id: InfrastructureLayerID("infrastructure-kerbs"),
		type: "line",
		minzoom: 17,
		filter: ["all", isLine, kindIs("barrier"), detailIn("kerb")],
		paint: {
			"line-color": InfrastructurePalette.kerb,
			"line-width": ["interpolate", ["linear"], ["zoom"], 17, 0.5, 20, 1.5],
		},
	},
	{
		// Zebra crossings: the crossing ways of the road network, striped across their direction.
		source: MailwomanBaseTileSetID,
		"source-layer": "roads",
		id: InfrastructureLayerID("crosswalks"),
		type: "line",
		minzoom: 17,
		filter: ["==", ["get", "kind_detail"], "crossing"],
		paint: {
			"line-color": InfrastructurePalette.crosswalk,
			"line-width": ["interpolate", ["exponential", 2], ["zoom"], 17, 5, 20, 24],
			"line-dasharray": [0.25, 0.25],
		},
	},
	{
		// A lane or track along a road, drawn as a thin blue line beside the carriageway.
		source: MailwomanBaseTileSetID,
		"source-layer": "roads",
		id: InfrastructureLayerID("bike-lanes"),
		type: "line",
		minzoom: 15,
		filter: ["has", "cycleway"],
		layout: { "line-cap": "round", "line-join": "round" },
		paint: {
			"line-color": InfrastructurePalette.bikeLane,
			"line-width": ["interpolate", ["linear"], ["zoom"], 15, 0.75, 19, 2],
			"line-offset": ["interpolate", ["exponential", 2], ["zoom"], 15, 2, 19, 10],
		},
	},
	{
		...base,
		id: InfrastructureLayerID("infrastructure-pipelines"),
		type: "line",
		minzoom: 14,
		filter: ["all", isLine, ["in", ["get", "kind"], ["literal", ["water", "man_made", "telecom"]]]],
		paint: {
			"line-color": [
				"match",
				["get", "kind"],
				"water",
				InfrastructurePalette.waterNetwork,
				"telecom",
				InfrastructurePalette.telecom,
				InfrastructurePalette.power,
			],
			"line-width": 1,
			"line-dasharray": [4, 2],
		},
	},
	{
		...base,
		id: InfrastructureLayerID("infrastructure-power-lines"),
		type: "line",
		minzoom: 12,
		filter: ["all", isLine, kindIs("power")],
		paint: {
			"line-color": InfrastructurePalette.power,
			"line-opacity": ["interpolate", ["linear"], ["zoom"], 12, 0.4, 15, 0.8],
			"line-width": ["match", ["get", "kind_detail"], "line", 1, 0.6],
		},
	},
	{
		...base,
		id: InfrastructureLayerID("infrastructure-towers"),
		type: "circle",
		minzoom: 15,
		filter: ["all", isPoint, ["in", ["get", "kind"], ["literal", ["power", "telecom"]]]],
		paint: {
			"circle-color": "#ffffff",
			"circle-stroke-color": [
				"match",
				["get", "kind"],
				"telecom",
				InfrastructurePalette.telecom,
				InfrastructurePalette.power,
			],
			"circle-stroke-width": 1,
			"circle-radius": [
				"interpolate",
				["linear"],
				["zoom"],
				15,
				["match", ["get", "kind_detail"], ["tower", "mast"], 1.5, 0.75],
				18,
				["match", ["get", "kind_detail"], ["tower", "mast"], 3.5, 2],
			],
		},
	},
	{
		...base,
		id: InfrastructureLayerID("infrastructure-street-marks"),
		type: "circle",
		minzoom: 16,
		filter: [
			"all",
			isPoint,
			[
				"in",
				["get", "kind"],
				["literal", ["emergency", "barrier", "water", "man_made", "highway", "amenity", "leisure", "power"]],
			],
		],
		paint: {
			"circle-color": [
				"match",
				["get", "kind_detail"],
				"fire_hydrant",
				InfrastructurePalette.hydrant,
				["water_tank", "suction_point"],
				InfrastructurePalette.cistern,
				"defibrillator",
				InfrastructurePalette.defibrillator,
				["water_tower", "storage_tank", "pumping_station"],
				InfrastructurePalette.waterNetwork,
				"post_box",
				InfrastructurePalette.postBox,
				["traffic_signals", "stop", "give_way", "speed_camera", "traffic_mirror"],
				InfrastructurePalette.signal,
				"street_lamp",
				InfrastructurePalette.streetLamp,
				["bench", "picnic_table", "waste_basket", "recycling", "bicycle_parking", "vending_machine"],
				InfrastructurePalette.furniture,
				["pole", "utility_pole", "manhole"],
				InfrastructurePalette.power,
				["drinking_water", "telephone"],
				InfrastructurePalette.cistern,
				InfrastructurePalette.wall,
			],
			"circle-radius": ["interpolate", ["linear"], ["zoom"], 16, 1.5, 19, 3.5],
			"circle-stroke-color": "#ffffff",
			"circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 16, 0.5, 19, 1],
		},
	},
]
