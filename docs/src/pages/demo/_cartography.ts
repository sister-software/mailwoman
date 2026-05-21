/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Ported from sister-software/isp-nexus's `cartographer` module (under the same AGPL terms).
 *   Provides:
 *
 *   - `MailwomanDarkTheme` — the Nexus dark Protomaps palette (suitable for dark-mode pages).
 *   - `MailwomanLightTheme` — protomaps-themes-base's default `light` (no Nexus light theme exists).
 *   - `buildMapStyle(theme)` — composes a full MapLibre style with self-hosted glyphs + sprites
 *
 *       - Terrain DEM source + sky spec.
 *
 *   Self-hosting: glyphs + sprites are served from public.sister.software/protomaps/* so the demo
 *   doesn't depend on protomaps.github.io's static-site availability.
 */

import * as protomapsThemes from "protomaps-themes-base"

const SOURCE_NAME = "protomaps"
const TILE_URL = "https://tiles.sister.software/basemap/{z}/{x}/{y}.mvt"
const GLYPHS_URL = "https://public.sister.software/protomaps/fonts/{fontstack}/{range}.pbf"
const SPRITE_URL_BASE = "https://public.sister.software/protomaps/sprites/v3"
const TERRAIN_SOURCE = "terrain"
const TERRAIN_URL = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png"
const ATTRIBUTION = '<a href="https://www.openstreetmap.org/copyright" target="_blank">© OpenStreetMap contributors</a>'

export type MapTheme = "light" | "dark"

/** Nexus dark theme — full Protomaps palette in HSL dark tones. */
const MailwomanDarkTheme: Parameters<typeof protomapsThemes.layersWithCustomTheme>[1] = {
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
	tunnel_other_casing: "#141414",
	tunnel_minor_casing: "#141414",
	tunnel_link_casing: "#141414",
	tunnel_medium_casing: "#141414",
	tunnel_major_casing: "#141414",
	tunnel_highway_casing: "#141414",
	tunnel_other: "#292929",
	tunnel_minor: "#292929",
	tunnel_link: "#292929",
	tunnel_medium: "#292929",
	tunnel_major: "#292929",
	tunnel_highway: "#292929",
	transit_pier: "#333333",
	buildings: "#111111",
	minor_service_casing: "#1f1f1f",
	minor_casing: "#1f1f1f",
	link_casing: "#1f1f1f",
	medium_casing: "#1f1f1f",
	major_casing_late: "#1f1f1f",
	highway_casing_late: "#1f1f1f",
	other: "#333333",
	minor_service: "#333333",
	minor_a: "#3d3d3d",
	minor_b: "#333333",
	link: "#3d3d3d",
	medium: "#3d3d3d",
	major_casing_early: "#1f1f1f",
	major: "#3d3d3d",
	highway_casing_early: "#1f1f1f",
	highway: "hsl(36deg 10% 50%)",
	railway: "#000000",
	boundaries: "hsl(240deg 100% 90%)",
	waterway_label: "#717784",
	bridges_other_casing: "#2b2b2b",
	bridges_minor_casing: "#1f1f1f",
	bridges_link_casing: "#1f1f1f",
	bridges_medium_casing: "#1f1f1f",
	bridges_major_casing: "#1f1f1f",
	bridges_highway_casing: "#1f1f1f",
	bridges_other: "#333333",
	bridges_minor: "#333333",
	bridges_link: "#3d3d3d",
	bridges_medium: "#3d3d3d",
	bridges_major: "#3d3d3d",
	bridges_highway: "#474747",
	roads_label_minor: "hsl(240deg 100% 90%)",
	roads_label_minor_halo: "#1f1f1f",
	roads_label_major: "hsl(240deg 100% 90%)",
	roads_label_major_halo: "#1f1f1f",
	ocean_label: "#717784",
	peak_label: "#898080",
	subplace_label: "hsl(50deg 50% 70%)",
	subplace_label_halo: "hsl(40deg 100% 10%)",
	city_label: "hsl(50deg 100% 90%)",
	city_label_halo: "hsl(240deg 100% 10%)",
	state_label: "hsl(240deg 100% 90%)",
	state_label_halo: "#1f1f1f",
	country_label: "hsl(240deg 50% 80% / 0.5)",
}

/**
 * Compose a MapLibre style. Light mode uses protomaps-themes-base's stock `light` theme; dark mode
 * uses the ported Nexus palette via `layersWithCustomTheme`. Terrain DEM source (Mapzen's
 * publicly-hosted terrarium tiles on AWS S3) is wired in so callers can toggle 3D terrain via
 * map.setTerrain({ source: "terrain", exaggeration: 1 }).
 */
export function buildMapStyle(theme: MapTheme): unknown {
	const layers =
		theme === "dark"
			? protomapsThemes.layersWithCustomTheme(SOURCE_NAME, MailwomanDarkTheme, "en")
			: protomapsThemes.default(SOURCE_NAME, theme, "en")

	return {
		version: 8,
		glyphs: GLYPHS_URL,
		sprite: `${SPRITE_URL_BASE}/${theme}`,
		sky: {
			"sky-color": theme === "dark" ? "#000535" : "#9bcef0",
			"horizon-color": theme === "dark" ? "hsl(54deg 100% 16%)" : "#dfe6ed",
			"fog-color": theme === "dark" ? "hsl(54deg 100% 5%)" : "#ffffff",
			"sky-horizon-blend": 0.75,
			"horizon-fog-blend": 0.75,
			"fog-ground-blend": 0.1,
		},
		sources: {
			[SOURCE_NAME]: {
				type: "vector",
				tiles: [TILE_URL],
				maxzoom: 15,
				attribution: ATTRIBUTION,
			},
			[TERRAIN_SOURCE]: {
				type: "raster-dem",
				encoding: "terrarium",
				tiles: [TERRAIN_URL],
				tileSize: 256,
				maxzoom: 15,
			},
		},
		layers,
	}
}

/**
 * Read the current map theme from Docusaurus's `data-theme` attribute on <html>. Returns "light"
 * when unset / SSR — initial render matches the light default until the client hydrates.
 */
export function currentMapTheme(): MapTheme {
	if (typeof document === "undefined") return "light"
	return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"
}
