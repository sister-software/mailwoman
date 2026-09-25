/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { escapeHTML } from "@mailwoman/core/strings/escape"
import type { GeoFeatureCollection, PointLiteral } from "@mailwoman/spatial"
import { layers, namedFlavor } from "@protomaps/basemaps"

import type { MapFeatureData } from "#types"

const MAPLIBRE_VERSION = "5.24.0"
const MAPLIBRE_JS_SRI = "sha384-5+cfbwT0iiub6VsQAdn6yz16nr6sDiQoHx6tm4O8OVYXHYOxcffFmCJBL0dgdvGp"
const MAPLIBRE_CSS_SRI = "sha384-uTttxo/aOKbdE5RlD/SPzSDoDmNvGlUYPjONi2MN/b7c9HPSvW07OIuyP7uL6jxK"

const BASEMAP_SOURCE_ID = "basemap-v4"
const BASEMAP_TILEJSON_URL = "https://tiles.mailwoman.ai/basemap-v4.json"
const GLYPHS_URL = "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf"
const SPRITE_URL = "https://protomaps.github.io/basemaps-assets/sprites/v4/light"

/**
 * Protomaps stock flavors (shipped by `@protomaps/basemaps`).
 */
export type MapFlavor = "light" | "dark" | "white" | "grayscale" | "black"

/**
 * Options for {@link toMapHTML}.
 *
 * With `colorBy: "auto"`, markers are colored by `bucket` when any feature carries one
 * and otherwise by whether two or more sources agree.
 */
export interface MapHTMLOptions {
	/**
	 * Sets the document title and on-map heading, defaulting to `Mailwoman — resolved entities`.
	 */
	title?: string

	/**
	 * Selects the Protomaps basemap flavor, defaulting to `light`, over which the markers read clearly.
	 */
	flavor?: MapFlavor

	/**
	 * Chooses marker colors: `bucket` uses the `bucket` property, `sources` shows whether two
	 * or more sources are linked, and the default `auto` picks `bucket` when any feature carries one.
	 */
	colorBy?: "auto" | "sources" | "bucket"
}

const PALETTE = ["#2f9e44", "#f08c00", "#1971c2", "#e8590c", "#9c36b5", "#0c8599", "#e03131", "#5c940d"]

const SINGLE_COLOR = "#3388ff"

const CROSS_COLOR = "#e8590c"

function safeJSONForScript(value: unknown): string {
	return stringifyJSON(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026")
}

function sourceCount(props: MapFeatureData): number {
	return Array.isArray(props["sources"]) ? props["sources"].length : 0
}

/**
 * Renders a {@link toGeoJSON} or reconciliation feature collection as a standalone MapLibre
 * HTML document, with an empty-state panel when the collection has no features.
 */
export function toMapHTML(
	geojson: GeoFeatureCollection<PointLiteral, MapFeatureData>,
	options: MapHTMLOptions = {}
): string {
	const title = options.title ?? "Mailwoman — resolved entities"
	const flavorName = options.flavor ?? "light"
	const colorBy = options.colorBy ?? "auto"

	const hasBuckets = geojson.features.some((f) => f.properties?.["bucket"] != null)
	const mode = colorBy === "auto" ? (hasBuckets ? "bucket" : "sources") : colorBy

	const bucketColors: Record<string, string> = {}

	if (mode === "bucket") {
		let i = 0

		for (const f of geojson.features) {
			const b = f.properties?.["bucket"] != null ? String(f.properties["bucket"]) : "—"

			if (!(b in bucketColors)) {
				bucketColors[b] = PALETTE[i++ % PALETTE.length]!
			}
		}
	}

	const colorFor = (props: MapFeatureData): string => {
		if (mode === "bucket") {
			const b = props["bucket"] != null ? String(props["bucket"]) : "—"

			return bucketColors[b] ?? SINGLE_COLOR
		}

		return sourceCount(props) >= 2 ? CROSS_COLOR : SINGLE_COLOR
	}

	let minLng = Infinity
	let minLat = Infinity
	let maxLng = -Infinity
	let maxLat = -Infinity

	const features = geojson.features.map((f) => {
		const [lng, lat] = f.geometry.coordinates

		if (lng < minLng) {
			minLng = lng
		}

		if (lat < minLat) {
			minLat = lat
		}

		if (lng > maxLng) {
			maxLng = lng
		}

		if (lat > maxLat) {
			maxLat = lat
		}

		return { ...f, properties: { ...f.properties, _color: colorFor(f.properties) } }
	})

	const bbox = features.length ? [[minLng, minLat] as const, [maxLng, maxLat] as const] : null

	const style = {
		version: 8,
		glyphs: GLYPHS_URL,
		sprite: SPRITE_URL,
		sources: {
			[BASEMAP_SOURCE_ID]: { type: "vector", url: BASEMAP_TILEJSON_URL },
			entities: { type: "geojson", data: { type: "FeatureCollection", features } },
		},
		layers: [
			...(layers(BASEMAP_SOURCE_ID, namedFlavor(flavorName), { lang: "en" }) as unknown[]),
			{
				id: "mw-entities",
				type: "circle",
				source: "entities",
				paint: {
					"circle-radius": [
						"interpolate",
						["linear"],
						["coalesce", ["get", "recordCount"], 1],
						1,
						5,
						5,
						9,
						25,
						15,
						100,
						22,
					],
					"circle-color": ["get", "_color"],
					"circle-stroke-color": "#ffffff",
					"circle-stroke-width": 1.2,
					"circle-opacity": 0.9,
				},
			},
		],
	}

	const legendRows =
		mode === "bucket"
			? Object.entries(bucketColors)
					.map(([b, c]) => `<div><i style="background:${c}"></i>${escapeHTML(b)}</div>`)
					.join("")
			: `<div><i style="background:${CROSS_COLOR}"></i>cross-dataset link (&ge;2 sources)</div>` +
				`<div><i style="background:${SINGLE_COLOR}"></i>single-source entity</div>` +
				`<div class="muted" style="margin-top:4px">marker size = records merged</div>`

	const crossLinks = geojson.features.filter((f) => sourceCount(f.properties) >= 2).length

	const summary =
		`${geojson.features.length} entities` + (mode === "sources" ? ` &middot; ${crossLinks} cross-dataset links` : "")

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHTML(title)}</title>
<link
	rel="stylesheet"
	href="https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.css"
	integrity="${MAPLIBRE_CSS_SRI}"
	crossorigin="anonymous" />
<style>
	html, body { margin: 0; height: 100%; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
	#map { position: absolute; inset: 0; }
	.mw-panel {
		position: absolute; z-index: 1; background: rgba(255,255,255,0.94); padding: 10px 12px;
		border-radius: 8px; box-shadow: 0 1px 6px rgba(0,0,0,0.3); font-size: 12px; line-height: 1.5; color: #1a1a1a;
	}
	.mw-title { top: 10px; left: 10px; max-width: 60%; }
	.mw-title h1 { font-size: 14px; margin: 0 0 4px; }
	.mw-legend { bottom: 22px; right: 10px; }
	.mw-legend i { display: inline-block; width: 12px; height: 12px; margin-right: 6px; border-radius: 50%; vertical-align: -1px; }
	.muted { color: #666; }
	.mw-popup { font-size: 12px; line-height: 1.5; max-width: 260px; }
	.mw-popup .nm { font-weight: 600; font-size: 13px; }
	.mw-popup dt { color: #666; display: inline; }
	.mw-popup .link { color: ${CROSS_COLOR}; font-weight: 600; }
	.mw-empty { position: absolute; inset: 0; display: grid; place-items: center; z-index: 1; }
	.mw-warn { bottom: 10px; left: 10px; max-width: 52%; background: rgba(255,243,205,0.97); }
	.mw-warn code { background: rgba(0,0,0,0.06); padding: 0 3px; border-radius: 3px; }
</style>
</head>
<body>
<div id="map"></div>
<div class="mw-panel mw-title"><h1>${escapeHTML(title)}</h1><div class="muted">${summary}</div></div>
${features.length ? `<div class="mw-panel mw-legend">${legendRows}</div>` : `<div class="mw-empty"><div class="mw-panel"><h1>${escapeHTML(title)}</h1><div class="muted">No geocoded entities to display.</div></div></div>`}
<script
	src="https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.js"
	integrity="${MAPLIBRE_JS_SRI}"
	crossorigin="anonymous"></script>
<script>
"use strict";
var STYLE = ${safeJSONForScript(style)};
var BBOX = ${safeJSONForScript(bbox)};

function esc(v) {
	if (v === null || v === undefined) return "";
	return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function popupHTML(p) {
	var rows = [];
	var heading = p.name || p.organization || p.entityID || "entity";
	rows.push('<div class="nm">' + esc(heading) + '</div>');
	if (p.organization && p.organization !== p.name) rows.push('<div>' + esc(p.organization) + '</div>');
	if (p.address) rows.push('<div class="muted">' + esc(p.address) + '</div>');
	rows.push('<hr style="border:none;border-top:1px solid #eee;margin:6px 0" />');
	rows.push('<div><dt>records merged:</dt> ' + esc(p.recordCount) + '</div>');
	var srcs = Array.isArray(p.sources) ? p.sources : [];
	if (srcs.length) {
		var cls = srcs.length >= 2 ? ' class="link"' : '';
		rows.push('<div><dt>sources:</dt> <span' + cls + '>' + esc(srcs.join(", ")) + '</span>'
			+ (srcs.length >= 2 ? ' (cross-dataset link)' : '') + '</div>');
	}
	if (p.bucket !== null && p.bucket !== undefined) rows.push('<div><dt>bucket:</dt> ' + esc(p.bucket) + '</div>');
	if (p.cohesion !== null && p.cohesion !== undefined) rows.push('<div><dt>cohesion:</dt> ' + esc(p.cohesion) + ' bits</div>');
	if (p.geocodeTier) rows.push('<div><dt>geocode tier:</dt> ' + esc(p.geocodeTier) + '</div>');
	return '<div class="mw-popup">' + rows.join("") + '</div>';
}

var map = new maplibregl.Map({ container: "map", style: STYLE, center: [-98, 39], zoom: 3, attributionControl: { compact: true } });
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

map.on("load", function () {
	if (BBOX) map.fitBounds(BBOX, { padding: 56, maxZoom: 15, duration: 0 });
});
map.on("click", "mw-entities", function (e) {
	var f = e.features && e.features[0];
	if (!f) return;
	new maplibregl.Popup({ closeButton: true }).setLngLat(e.lngLat).setHTML(popupHTML(f.properties || {})).addTo(map);
});
map.on("mouseenter", "mw-entities", function () { map.getCanvas().style.cursor = "pointer"; });
map.on("mouseleave", "mw-entities", function () { map.getCanvas().style.cursor = ""; });

// The house basemap tiles are cors-restricted to localhost + the docs domain, so a page opened
// straight off disk (file://) shows the markers on a blank basemap. Make that explicit rather than
// silent — the entity positions are correct regardless of whether the basemap paints.
if (location.protocol === "file:") {
	var warn = document.createElement("div");
	warn.className = "mw-panel mw-warn";
	warn.innerHTML = "⚠ Basemap tiles are blocked from <code>file://</code>. Serve this over "
		+ "<code>http://localhost</code> (e.g. <code>npx serve</code> or <code>python3 -m http.server</code>) "
		+ "to see the map background — the markers are accurate either way.";
	document.body.appendChild(warn);
}
</script>
</body>
</html>
`
}
