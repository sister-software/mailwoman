/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Render a race-by-dot-density PMTiles tileset (from `race-dots.ts` → tippecanoe) as a standalone
 *   MapLibre page on the house stack: the Protomaps `basemap-v4` vector basemap (layers generated +
 *   inlined here, à la `registry/map-html.ts`) under a circle layer of the dots, colored by race
 *   category. The dots PMTiles is read client-side via the `pmtiles` protocol.
 *
 *   Each dot is one of `--per` people of a category, placed at random inside its Census block — a
 *   representation, not a record about any address. Serve over localhost (the house tile server
 *   CORS-restricts to localhost + the docs domains).
 *
 *   Run: node scripts/census/race-dots-map.ts\
 *   --pmtiles-url http://localhost:8899/race-dots-oc.pmtiles --out /tmp/race-dots-oc.html
 */

import { writeFileSync } from "node:fs"
import { parseArgs } from "node:util"

import { layers, namedFlavor } from "@protomaps/basemaps"

// Loose scan parity with the retired local argv helpers: unknown flags tolerated.
const { values: rawValues } = parseArgs({
	options: {
		lat: { type: "string" },
		lng: { type: "string" },
		out: { type: "string" },
		per: { type: "string" },
		"pmtiles-url": { type: "string" },
		title: { type: "string" },
		zoom: { type: "string" },
	},
	strict: false,
	allowPositionals: true,
})
// Typed view: strict:false loosens TS inference, but declared options always parse to their schema type.
const values = rawValues as {
	lat?: string
	lng?: string
	out?: string
	per?: string
	"pmtiles-url"?: string
	title?: string
	zoom?: string
}
const PMTILES_URL = values["pmtiles-url"] || "http://localhost:8899/race-dots-oc.pmtiles"
const OUT = values["out"] || "/tmp/race-dots-oc.html"
const PER = Number(values["per"] || "5")
const PER_PHRASE = PER === 1 ? "one dot is one person" : `one dot ≈ ${PER} people`
const TITLE = values["title"] || `Race in Orange County, CA — ${PER_PHRASE} (2020 Census)`
const CENTER_LNG = Number(values["lng"] || "-117.83")
const CENTER_LAT = Number(values["lat"] || "33.68")
const ZOOM = Number(values["zoom"] || "9.4")

const MAPLIBRE_VERSION = "5.24.0"
const MAPLIBRE_JS_SRI = "sha384-5+cfbwT0iiub6VsQAdn6yz16nr6sDiQoHx6tm4O8OVYXHYOxcffFmCJBL0dgdvGp"
const MAPLIBRE_CSS_SRI = "sha384-uTttxo/aOKbdE5RlD/SPzSDoDmNvGlUYPjONi2MN/b7c9HPSvW07OIuyP7uL6jxK"
const PMTILES_VERSION = "4.4.1"

const BASEMAP_SOURCE_ID = "basemap-v4"
const BASEMAP_TILEJSON_URL = "https://tiles.sister.software/basemap-v4.json"
const GLYPHS_URL = "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf"
const SPRITE_URL = "https://protomaps.github.io/basemaps-assets/sprites/v4/light"

// Cooper Center "Racial Dot Map" palette, by `pl_block`/P2 category.
const CATEGORY_COLOR: Record<string, string> = {
	white: "#1f78b4", // blue
	black: "#33a02c", // green
	hispanic: "#ff7f00", // orange
	asian: "#e31a1c", // red
	aian: "#6a3d9a", // purple
	nhpi: "#00b3b3", // teal
	other: "#b15928", // brown
	multi: "#9e9e9e", // grey
}
const CATEGORY_LABEL: Record<string, string> = {
	white: "White (non-Hispanic)",
	black: "Black (non-Hispanic)",
	hispanic: "Hispanic or Latino",
	asian: "Asian (non-Hispanic)",
	aian: "Native American",
	nhpi: "Pacific Islander",
	other: "Other (non-Hispanic)",
	multi: "Two or more races",
}

const colorMatch: unknown[] = ["match", ["get", "cat"]]

for (const [cat, color] of Object.entries(CATEGORY_COLOR)) {
	colorMatch.push(cat, color)
}
colorMatch.push("#9e9e9e")

const style = {
	version: 8,
	glyphs: GLYPHS_URL,
	sprite: SPRITE_URL,
	sources: {
		[BASEMAP_SOURCE_ID]: { type: "vector", url: BASEMAP_TILEJSON_URL },
		dots: { type: "vector", url: "pmtiles://" + PMTILES_URL },
	},
	layers: [
		...(layers(BASEMAP_SOURCE_ID, namedFlavor("light"), { lang: "en" }) as unknown[]),
		{
			id: "race-dots",
			type: "circle",
			source: "dots",
			"source-layer": "dots",
			paint: {
				"circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 0.7, 9, 1.7, 12, 2.8, 16, 4.5],
				"circle-color": colorMatch,
				"circle-opacity": 0.85,
			},
		},
	],
}

const legendRows = Object.keys(CATEGORY_COLOR)
	.map((c) => `<div><i style="background:${CATEGORY_COLOR[c]}"></i>${CATEGORY_LABEL[c]}</div>`)
	.join("")

// The client script avoids template literals / `${` so it survives this outer template verbatim.
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${TITLE}</title>
<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.css" integrity="${MAPLIBRE_CSS_SRI}" crossorigin="anonymous" />
<style>
	html, body { margin: 0; height: 100%; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
	#map { position: absolute; inset: 0; background: #f4f4f2; }
	.mw-panel { position: absolute; z-index: 1; background: rgba(255,255,255,0.94); padding: 10px 12px; border-radius: 8px; box-shadow: 0 1px 6px rgba(0,0,0,0.3); font-size: 12px; line-height: 1.5; color: #1a1a1a; }
	.mw-title { top: 10px; left: 10px; max-width: 64%; }
	.mw-title h1 { font-size: 14px; margin: 0 0 4px; }
	.mw-legend { bottom: 22px; right: 10px; }
	.mw-legend i { display: inline-block; width: 11px; height: 11px; margin-right: 6px; border-radius: 50%; vertical-align: -1px; }
	.muted { color: #666; }
</style>
</head>
<body>
<div id="map"></div>
<div class="mw-panel mw-title"><h1>${TITLE}</h1><div class="muted">Each dot is ${PER === 1 ? "a person" : `~${PER} people`}, placed at random inside their Census block. Source: 2020 P.L. 94-171 (table P2) + TIGER blocks.</div></div>
<div class="mw-panel mw-legend">${legendRows}</div>
<script src="https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.js" integrity="${MAPLIBRE_JS_SRI}" crossorigin="anonymous"></script>
<script src="https://unpkg.com/pmtiles@${PMTILES_VERSION}/dist/pmtiles.js" crossorigin="anonymous"></script>
<script>
	var protocol = new pmtiles.Protocol();
	maplibregl.addProtocol("pmtiles", protocol.tile);
	var map = new maplibregl.Map({
		container: "map",
		style: ${JSON.stringify(style)},
		center: [${CENTER_LNG}, ${CENTER_LAT}],
		zoom: ${ZOOM},
		attributionControl: false
	});
	map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: "US Census 2020 · TIGER · Protomaps · OpenStreetMap" }));
</script>
</body>
</html>
`

writeFileSync(OUT, html)
console.error(`[written] ${OUT}  (pmtiles: ${PMTILES_URL})`)
