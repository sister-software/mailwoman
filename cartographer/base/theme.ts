/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type Flavor, namedFlavor } from "@protomaps/basemaps"

import { TileSetSourceID } from "../styles/sources.ts"

/**
 * Identifier for the Mailwoman base tileset. Matches the R2 object basename (`nexus-assets/tiles/basemap-v4.pmtiles`) —
 * `tiles.sister.software/basemap-v4.json` returns its tilejson, `tiles.sister.software/basemap-v4/{z}/{x}/{y}.mvt`
 * returns vector tiles.
 */
export const MailwomanBaseTileSetID = TileSetSourceID("basemap-v4")

const darkFlavor = namedFlavor("dark")

/**
 * The Mailwoman theme for Protomaps via MapLibre. Keys follow `@protomaps/basemaps@5.x` which targets the v4 tile
 * schema (`["==","kind","..."]` filters), matching the basemap-v4 PMTiles on R2.
 */
export const MailwomanBaseFlavor: Flavor = {
	...darkFlavor,

	//#region Base
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

	//#endregion
	//#region Tunnel
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

	//#endregion
	buildings: "#111111",

	//#region Casing
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

	//#endregion
	railway: "#000000",
	boundaries: "hsl(240deg 100% 90%)",

	//#region Bridges
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

	//#endregion

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
