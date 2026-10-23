/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { PROTOMAPS_PLANET_TILESET_NAME } from "@mailwoman/core/asset-paths"
import type { LightSpecification, SkySpecification } from "@maplibre/maplibre-gl-style-spec"
import { type Flavor, namedFlavor } from "@protomaps/basemaps"

import { MAP_FONT_ITALIC, MAP_FONT_MEDIUM, MAP_FONT_REGULAR } from "#styles/fonts"
import { TileSetSourceID } from "#styles/sources"

/**
 * Identifier for the Mailwoman base tileset.
 *
 * - `{tileset}.json` returns its tilejson,
 * - `{tileset}/{z}/{x}/{y}.mvt` returns vector tiles.
 */
export const MailwomanBaseTileSetID = TileSetSourceID(PROTOMAPS_PLANET_TILESET_NAME)

const lightFlavor = namedFlavor("light")
const darkFlavor = namedFlavor("dark")

/**
 * Colors of the Japanese street map, the convention shared by Japanese web and print atlases.
 *
 * The ground is a pale warm gray (街区).
 * Atlases tint each ward a different pastel.
 *
 * The base tiles hold only country polygons, so the ground is one color.
 *
 * Road color encodes administrative class: national routes (国道) are orange, prefectural roads
 * (都道府県道) yellow, expressways (高速道路) blue-violet, and every other street a bare white line.
 * Buildings are pale gray blocks, stations red, and green space a saturated yellow-green.
 *
 * Railways are dark lines hatched with white dashes.
 * Underground lines are red dashes.
 *
 * Municipal boundaries are a translucent red band under a dark dash-dot line.
 */
export const GuideMapPalette = {
	/**
	 * 街区: land.
	 */
	ground: "#efede8",
	/**
	 * 河川・海: water.
	 */
	water: "#cbdbf4",
	/**
	 * The edge of water bodies.
	 */
	waterEdge: "#b6c5db",
	/**
	 * 芝生等その他緑地: lawns and parks.
	 */
	lawn: "#bfdf94",
	/**
	 * 植栽地: planted ground and woods.
	 */
	planted: "#afcf70",
	/**
	 * The edge of planted ground.
	 */
	plantedEdge: "#9dba64",
	/**
	 * 運動場: sports grounds and the parks around stadiums.
	 */
	sportsGround: "#d4e9b4",
	/**
	 * 競技場のフィールド: pitches and stadium fields.
	 */
	pitch: "#a9d58a",
	/**
	 * 陸上トラック: running tracks.
	 */
	track: "#e7c9a9",
	/**
	 * 田: rice paddies.
	 */
	paddy: "#e3efc0",
	/**
	 * 砂地: sand.
	 */
	sand: "#f8f0a8",
	/**
	 * 学校: school grounds.
	 */
	school: "#ece7c6",
	/**
	 * 舗装地: paved lots and plazas.
	 */
	paved: "#e3e3d8",
	/**
	 * 鉄道敷地: railway land and restricted ground.
	 */
	railwayLand: "#dbdbdb",
	/**
	 * 道路: streets below the prefectural class.
	 */
	road: "#ffffff",
	/**
	 * The thin gray edge every road carries.
	 */
	roadEdge: "#a9a9a9",
	/**
	 * 3m未満道路: footpaths and narrow lanes.
	 */
	path: "#ffffff",
	/**
	 * The thin edge of a classed road, a darker tint of its fill.
	 */
	classedRoadEdge: "#cdb27a",
	/**
	 * 一方通行: one-way arrows.
	 */
	oneway: "#5b7fc4",
	/**
	 * 番地: house and block numbers.
	 */
	houseNumber: "#9a6a4c",
	/**
	 * 都道府県道・主要地方道: prefectural roads.
	 */
	prefecturalRoad: "#fcf39b",
	/**
	 * 国道: national routes.
	 */
	nationalRoad: "#efc784",
	/**
	 * 高速道路: expressways.
	 */
	expressway: "#7e92ce",
	/**
	 * 建物: buildings.
	 */
	building: "#f8f7f4",
	/**
	 * 建物の縁取り: building edges.
	 */
	buildingEdge: "#cfccc5",
	/**
	 * 駅: stations.
	 */
	station: "#dc7878",
	/**
	 * 鉄道: surface railway, hatched with white dashes.
	 */
	railway: "#4c4c4c",
	/**
	 * 地下鉄: underground railway.
	 */
	subway: "#f85c5c",
	/**
	 * 市区町村境界: the translucent band under a municipal boundary.
	 */
	boundaryBand: "#f85c5c",
	/**
	 * The color of the dash-dot line that marks the boundary over its band.
	 */
	boundaryLine: "#5a5a5a",
	/**
	 * Place names and the pictogram ink.
	 */
	ink: "#1a1919",
	/**
	 * 駅名: station names.
	 */
	stationName: "#1d4f9c",
	/**
	 * 町丁目: neighborhood names.
	 */
	district: "#6b6b6b",
} as const

/**
 * Scene light for the guide map.
 *
 * The guide maps' isometric drawings light buildings from the upper left.
 * Roofs stay the lightest face and walls fall to a soft mid tone.
 */
export const GuideMapLight: Partial<LightSpecification> = {
	color: "#ffffff",
	intensity: 0.3,
	anchor: "viewport",
	position: [1.5, 200, 35],
}

/**
 * Sky for the guide map: a pale haze in place of the dark theme's night sky.
 */
export const GuideMapSky: Partial<SkySpecification> = {
	"sky-color": "#eef1f3",
	"horizon-color": "#f6f4ef",
	"fog-color": GuideMapPalette.ground,
}

/**
 * The Mailwoman theme for Protomaps via MapLibre, following the Japanese white guide map.
 *
 * Keys follow `@protomaps/basemaps@5.x` which targets the v4 tile schema
 * (`["==","kind","..."]` filters), matching the planet.v4 PMTiles on R2.
 * `BaseLayers` colors major roads by class, hatches railways and draws the boundary band,
 * because a flavor sets one color per layer.
 */
export const MailwomanBaseFlavor: Flavor = {
	...lightFlavor,

	regular: MAP_FONT_REGULAR,
	bold: MAP_FONT_MEDIUM,
	italic: MAP_FONT_ITALIC,

	// #region Base
	// The `earth` layer fills every landmass, so the background shows only where a tile has not loaded.
	// On the globe that is mostly open sea, and the deep-water color hides the loading tile.
	background: "#597eb0",
	earth: GuideMapPalette.ground,

	park_a: GuideMapPalette.lawn,
	park_b: GuideMapPalette.lawn,

	hospital: GuideMapPalette.paved,
	industrial: GuideMapPalette.railwayLand,
	school: GuideMapPalette.school,
	wood_a: GuideMapPalette.planted,
	wood_b: GuideMapPalette.planted,
	pedestrian: GuideMapPalette.paved,
	scrub_a: GuideMapPalette.lawn,
	scrub_b: GuideMapPalette.lawn,
	glacier: "#f4f7fb",
	sand: GuideMapPalette.sand,
	beach: GuideMapPalette.sand,
	aerodrome: GuideMapPalette.railwayLand,
	runway: GuideMapPalette.railwayLand,

	water: GuideMapPalette.water,

	pier: GuideMapPalette.railwayLand,
	zoo: GuideMapPalette.lawn,
	military: GuideMapPalette.railwayLand,

	// #endregion
	// #region Tunnel
	tunnel_other_casing: GuideMapPalette.roadEdge,
	tunnel_minor_casing: GuideMapPalette.roadEdge,
	tunnel_link_casing: GuideMapPalette.roadEdge,
	tunnel_major_casing: GuideMapPalette.roadEdge,
	tunnel_highway_casing: GuideMapPalette.roadEdge,
	tunnel_other: GuideMapPalette.road,
	tunnel_minor: GuideMapPalette.road,
	tunnel_link: GuideMapPalette.road,
	tunnel_major: GuideMapPalette.road,
	tunnel_highway: GuideMapPalette.road,

	// #endregion
	buildings: GuideMapPalette.building,

	// #region Casing
	// Classed roads keep a thin edge. The minor-street edges are hidden in `toGuideMapLayers`.
	minor_service_casing: GuideMapPalette.roadEdge,
	minor_casing: GuideMapPalette.roadEdge,
	link_casing: GuideMapPalette.roadEdge,
	major_casing_late: GuideMapPalette.classedRoadEdge,
	highway_casing_late: GuideMapPalette.roadEdge,
	other: GuideMapPalette.path,
	minor_service: GuideMapPalette.road,
	minor_a: GuideMapPalette.road,
	minor_b: GuideMapPalette.road,
	link: GuideMapPalette.nationalRoad,
	// At city zoom a road is one or two pixels wide, so a gray edge would outweigh its fill.
	// The early casings are darker tints of the fills, which keeps the road class readable.
	major_casing_early: "#d9c983",
	major: GuideMapPalette.prefecturalRoad,
	highway_casing_early: "#5f72ad",
	highway: GuideMapPalette.expressway,

	// #endregion
	railway: GuideMapPalette.railway,
	boundaries: GuideMapPalette.boundaryLine,

	// #region Bridges
	bridges_other_casing: GuideMapPalette.roadEdge,
	bridges_minor_casing: GuideMapPalette.roadEdge,
	bridges_link_casing: GuideMapPalette.roadEdge,
	bridges_major_casing: GuideMapPalette.roadEdge,
	bridges_highway_casing: GuideMapPalette.roadEdge,
	bridges_other: GuideMapPalette.path,
	bridges_minor: GuideMapPalette.road,
	bridges_link: GuideMapPalette.nationalRoad,
	bridges_major: GuideMapPalette.prefecturalRoad,
	bridges_highway: GuideMapPalette.expressway,

	// #endregion

	roads_label_minor: "#444444",
	roads_label_minor_halo: "#ffffff",
	roads_label_major: "#333333",
	roads_label_major_halo: "#ffffff",

	ocean_label: "#4d6fa8",
	subplace_label: GuideMapPalette.district,
	subplace_label_halo: "#ffffff",

	city_label: GuideMapPalette.ink,
	city_label_halo: "#ffffff",

	state_label: GuideMapPalette.ink,
	state_label_halo: "#ffffff",
	country_label: "#333333",
	address_label: GuideMapPalette.houseNumber,
	address_label_halo: "#ffffff",

	// Facility names print near-black, so the POI label colors stay dark and close to neutral.
	// Transit takes the station-name blue.
	pois: {
		blue: "#2f4f7a",
		green: "#3f6b2e",
		lapis: GuideMapPalette.stationName,
		pink: "#8a3f3a",
		red: "#8a3f3a",
		slategray: "#3a3a3a",
		tangerine: "#5e4128",
		turquoise: "#2f6a70",
	},

	landcover: {
		grassland: GuideMapPalette.lawn,
		barren: GuideMapPalette.ground,
		farmland: "#e6efc4",
		forest: GuideMapPalette.planted,
		glacier: "#f4f7fb",
		scrub: GuideMapPalette.lawn,
		urban_area: GuideMapPalette.ground,
	},
}

/**
 * The earlier dark Mailwoman theme, kept as the starting point for a dark guide map.
 *
 * The guide-map color table's black map (黒地図) column gives the dark counterparts
 * of {@linkcode GuideMapPalette}.
 */
export const MailwomanDarkFlavor: Flavor = {
	...darkFlavor,

	regular: MAP_FONT_REGULAR,
	bold: MAP_FONT_MEDIUM,
	italic: MAP_FONT_ITALIC,

	// #region Base
	background: "hsl(0deg 10% 5%)",
	earth: "hsl(0deg 10% 5%)",

	park_a: "hsl(120deg 45.75% 1%)",
	park_b: "hsl(120deg 65.75% 10%)",

	hospital: "#252424",
	industrial: "#222222",
	school: "#262323",
	wood_a: "#202121",
	wood_b: "#202121",
	pedestrian: "#1e1e1e",
	scrub_a: "#222323",
	scrub_b: "#222323",
	glacier: "#1c1c1c",
	sand: "#212123",
	beach: "hsl(44.24deg 100% 20% / 0.1)",
	aerodrome: "#1e1e1e",
	runway: "#333333",

	water: "hsl(194deg 100% 10%)",

	pier: "#222222",
	zoo: "#222323",
	military: "#242323",

	// #endregion
	// #region Tunnel
	tunnel_other_casing: "#141414",
	tunnel_minor_casing: "#141414",
	tunnel_link_casing: "#141414",
	tunnel_major_casing: "#141414",
	tunnel_highway_casing: "#141414",
	tunnel_other: "#292929",
	tunnel_minor: "#292929",
	tunnel_link: "#292929",
	tunnel_major: "#292929",
	tunnel_highway: "#292929",

	// #endregion
	buildings: "#111111",

	// #region Casing
	minor_service_casing: "#1f1f1f",
	minor_casing: "#1f1f1f",
	link_casing: "#1f1f1f",
	major_casing_late: "#1f1f1f",
	highway_casing_late: "#1f1f1f",
	other: "#333333",
	minor_service: "#333333",
	minor_a: "#3d3d3d",
	minor_b: "#333333",
	link: "#3d3d3d",
	major_casing_early: "#1f1f1f",
	major: "#3d3d3d",
	highway_casing_early: "#1f1f1f",
	highway: "hsl(36deg 10% 50%)",

	// #endregion
	railway: "#000000",
	boundaries: "hsl(240deg 100% 90%)",

	// #region Bridges
	bridges_other_casing: "#2b2b2b",
	bridges_minor_casing: "#1f1f1f",
	bridges_link_casing: "#1f1f1f",
	bridges_major_casing: "#1f1f1f",
	bridges_highway_casing: "#1f1f1f",
	bridges_other: "#333333",
	bridges_minor: "#333333",
	bridges_link: "#3d3d3d",
	bridges_major: "#3d3d3d",
	bridges_highway: "#474747",

	// #endregion

	ocean_label: "#717784",
	subplace_label: "hsl(50deg 50% 70%)",
	subplace_label_halo: "hsl(40deg 100% 10%)",

	city_label: "hsl(50deg 100% 90%)",
	city_label_halo: "hsl(240deg 100% 10%)",

	state_label: "hsl(240deg 100% 90%)",
	state_label_halo: "#1f1f1f",
	country_label: "hsl(240deg 50% 80% / 0.5)",
	address_label: "hsl(240deg 100% 90%)",
	address_label_halo: "hsl(240deg 100% 10%)",

	landcover: {
		grassland: "hsl(120deg 45.75% 1%)",
		barren: "hsl(0deg 100% 2.84%)",
		farmland: "hsl(120deg 45.75% 1%)",
		forest: "hsl(120deg 45.75% 1%)",
		glacier: "hsl(240deg 100% 10%)",
		scrub: "hsl(0deg 10% 5%)",
		urban_area: "hsl(0deg 10% 5%)",
	},
}
