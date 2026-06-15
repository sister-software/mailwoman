/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Render resolved entities as a standalone, self-contained map you can just open in a browser —
 *   the visual complement to {@link toGeoJSON}'s analyst/QGIS export. Until now the matcher's only
 *   output surface was raw GeoJSON ("open it in QGIS"); this turns the same FeatureCollection into
 *   one HTML file (Leaflet from a pinned CDN + open basemap tiles, the data inlined) that shows each
 *   entity as a point, sized by how many records merged into it and colored by whether it spans ≥2
 *   sources (a cross-dataset link) — or, when the features carry a `bucket` property (the
 *   reconciliation output), colored categorically by that bucket.
 *
 *   This is a NEUTRAL entity-resolution view: it shows what resolved to what and how confidently
 *   (cohesion). It draws no conclusions about the records themselves — bucket labels are rendered
 *   verbatim from the data, never editorialized.
 *
 *   Pure: GeoJSON in, HTML string out. No I/O, no network at generate time. The generated page does
 *   fetch Leaflet + map tiles from the network when opened (standard for any web map).
 */

import type { GeoJsonFeatureCollection } from "./types.js"

/** Leaflet release the generated page pins (CDN + Subresource-Integrity hashes from the official dist). */
const LEAFLET_VERSION = "1.9.4"
const LEAFLET_CSS_SRI = "sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
const LEAFLET_JS_SRI = "sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="

/** Basemap tile choices. All are free for reasonable use and require attribution (rendered in-map). */
const BASEMAPS = {
	osm: {
		url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
		attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
		maxZoom: 19,
	},
	"carto-light": {
		url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
		attribution:
			'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
		maxZoom: 20,
	},
	"carto-dark": {
		url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
		attribution:
			'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
		maxZoom: 20,
	},
} as const

export interface MapHTMLOptions {
	/** Document `<title>` + the on-map heading. Default: "Mailwoman — resolved entities". */
	title?: string
	/** Basemap tiles. Default: "osm". */
	basemap?: keyof typeof BASEMAPS
	/**
	 * How to color the markers:
	 *
	 * - `"auto"` (default) — color by the `bucket` property if ANY feature carries one (reconciliation
	 *   output), otherwise color cross-dataset links (entities spanning ≥2 sources) apart from
	 *   single-source entities.
	 * - `"sources"` — always color by cross-dataset link status.
	 * - `"bucket"` — always color by the `bucket` property (features without one fall into "—").
	 */
	colorBy?: "auto" | "sources" | "bucket"
}

/**
 * Escape a string for safe inlining inside an HTML `<script>` block as part of a JSON literal.
 * `JSON.stringify` alone is not enough: a record value containing `</script>` would close the block
 * early. Escaping `<`, `>`, and `&` to their `\uXXXX` forms keeps the JSON valid while making a
 * `</script>` breakout impossible. (Popup rendering escapes again, client-side, against HTML
 * injection — see the template's `esc()`.)
 */
function safeJsonForScript(value: unknown): string {
	return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
}

/** Escape text destined for the HTML document body (the heading/title), not the inlined script. */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
}

/**
 * Render `geojson` (a {@link toGeoJSON} FeatureCollection) as a complete, standalone HTML document.
 * Open the returned string in any browser; no server or build step. Entities without a coordinate
 * are already absent from a `toGeoJSON` collection, so an empty collection renders a friendly
 * "nothing to show" state rather than a broken map.
 */
export function toMapHTML(geojson: GeoJsonFeatureCollection, options: MapHTMLOptions = {}): string {
	const title = options.title ?? "Mailwoman — resolved entities"
	const basemapKey = options.basemap && options.basemap in BASEMAPS ? options.basemap : "osm"
	const basemap = BASEMAPS[basemapKey]
	const colorBy = options.colorBy ?? "auto"

	const featureCount = geojson.features.length
	const data = safeJsonForScript(geojson)

	// The client-side script is intentionally written with string concatenation (no template literals
	// and no `${`), so it survives being embedded in this outer template literal verbatim.
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<link
	rel="stylesheet"
	href="https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css"
	integrity="${LEAFLET_CSS_SRI}"
	crossorigin="" />
<style>
	html, body { margin: 0; height: 100%; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
	#map { position: absolute; inset: 0; }
	.mw-panel {
		background: rgba(255,255,255,0.94); padding: 10px 12px; border-radius: 8px;
		box-shadow: 0 1px 6px rgba(0,0,0,0.25); font-size: 12px; line-height: 1.5; color: #1a1a1a;
	}
	.mw-panel h1 { font-size: 14px; margin: 0 0 4px; }
	.mw-panel .muted { color: #666; }
	.mw-legend i { display: inline-block; width: 12px; height: 12px; margin-right: 6px; border-radius: 50%; vertical-align: -1px; }
	.mw-popup { font-size: 12px; line-height: 1.5; max-width: 260px; }
	.mw-popup .nm { font-weight: 600; font-size: 13px; }
	.mw-popup dt { color: #666; }
	.mw-popup .link { color: #e8590c; font-weight: 600; }
	.mw-empty { position: absolute; inset: 0; display: grid; place-items: center; color: #444; }
</style>
</head>
<body>
<div id="map"></div>
<script
	src="https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js"
	integrity="${LEAFLET_JS_SRI}"
	crossorigin=""></script>
<script>
"use strict";
var DATA = ${data};
var TITLE = ${safeJsonForScript(title)};
var COLOR_BY = ${safeJsonForScript(colorBy)};
var BASE_URL = ${safeJsonForScript(basemap.url)};
var BASE_ATTR = ${safeJsonForScript(basemap.attribution)};
var BASE_MAXZOOM = ${basemap.maxZoom};

// Categorical palette (color-blind-friendly-ish) reused for buckets; cycles if there are more buckets.
var PALETTE = ["#2f9e44", "#f08c00", "#1971c2", "#e8590c", "#9c36b5", "#0c8599", "#e03131", "#5c940d"];
var SINGLE_COLOR = "#3388ff";   // single-source entity
var CROSS_COLOR  = "#e8590c";   // cross-dataset link (>= 2 sources)

function esc(v) {
	if (v === null || v === undefined) return "";
	return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Does the data carry bucket labels? (reconciliation output)
var hasBuckets = DATA.features.some(function (f) { return f.properties && f.properties.bucket != null; });
var mode = COLOR_BY === "auto" ? (hasBuckets ? "bucket" : "sources") : COLOR_BY;

// Stable color assignment for bucket values, in first-seen order.
var bucketColors = {};
(function () {
	var i = 0;
	DATA.features.forEach(function (f) {
		var b = f.properties && f.properties.bucket != null ? String(f.properties.bucket) : "—";
		if (!(b in bucketColors)) { bucketColors[b] = PALETTE[i % PALETTE.length]; i++; }
	});
})();

function sourceCount(props) {
	return Array.isArray(props.sources) ? props.sources.length : 0;
}

function colorFor(props) {
	if (mode === "bucket") {
		var b = props.bucket != null ? String(props.bucket) : "—";
		return bucketColors[b] || SINGLE_COLOR;
	}
	return sourceCount(props) >= 2 ? CROSS_COLOR : SINGLE_COLOR;
}

function radiusFor(props) {
	var n = props.recordCount || 1;
	return Math.max(4, Math.min(20, 4 + Math.sqrt(n) * 2));
}

function popupHtml(props) {
	var rows = [];
	var heading = props.name || props.organization || props.entityId || "entity";
	rows.push('<div class="nm">' + esc(heading) + '</div>');
	if (props.organization && props.organization !== props.name) {
		rows.push('<div>' + esc(props.organization) + '</div>');
	}
	if (props.address) rows.push('<div class="muted">' + esc(props.address) + '</div>');
	rows.push('<hr style="border:none;border-top:1px solid #eee;margin:6px 0" />');
	rows.push('<div><dt style="display:inline">records merged:</dt> ' + esc(props.recordCount) + '</div>');
	var srcs = Array.isArray(props.sources) ? props.sources : [];
	if (srcs.length) {
		var cls = srcs.length >= 2 ? ' class="link"' : '';
		rows.push('<div><dt style="display:inline">sources:</dt> <span' + cls + '>' + esc(srcs.join(", ")) + '</span>'
			+ (srcs.length >= 2 ? ' (cross-dataset link)' : '') + '</div>');
	}
	if (props.bucket != null) rows.push('<div><dt style="display:inline">bucket:</dt> ' + esc(props.bucket) + '</div>');
	if (props.cohesion != null) rows.push('<div><dt style="display:inline">cohesion:</dt> ' + esc(props.cohesion) + ' bits</div>');
	if (props.geocodeTier) rows.push('<div><dt style="display:inline">geocode tier:</dt> ' + esc(props.geocodeTier) + '</div>');
	return '<div class="mw-popup">' + rows.join("") + '</div>';
}

var map = L.map("map", { preferCanvas: true });
L.tileLayer(BASE_URL, { attribution: BASE_ATTR, maxZoom: BASE_MAXZOOM }).addTo(map);

if (!DATA.features.length) {
	document.body.insertAdjacentHTML("beforeend",
		'<div class="mw-empty"><div class="mw-panel"><h1>' + esc(TITLE) + '</h1>'
		+ '<div class="muted">No geocoded entities to display.</div></div></div>');
	map.setView([20, 0], 2);
} else {
	var layer = L.geoJSON(DATA, {
		pointToLayer: function (feature, latlng) {
			var p = feature.properties || {};
			return L.circleMarker(latlng, {
				radius: radiusFor(p), color: "#fff", weight: 1,
				fillColor: colorFor(p), fillOpacity: 0.85
			});
		},
		onEachFeature: function (feature, lyr) { lyr.bindPopup(popupHtml(feature.properties || {})); }
	}).addTo(map);
	map.fitBounds(layer.getBounds().pad(0.1));

	// Title + summary panel (top-left).
	var info = L.control({ position: "topleft" });
	info.onAdd = function () {
		var crossLinks = DATA.features.filter(function (f) { return sourceCount(f.properties || {}) >= 2; }).length;
		var div = L.DomUtil.create("div", "mw-panel");
		div.innerHTML = '<h1>' + esc(TITLE) + '</h1>'
			+ '<div class="muted">' + DATA.features.length + ' entities'
			+ (mode === "sources" ? ' &middot; ' + crossLinks + ' cross-dataset links' : '') + '</div>';
		return div;
	};
	info.addTo(map);

	// Legend (bottom-right): bucket categories, or the cross-dataset / single-source split.
	var legend = L.control({ position: "bottomright" });
	legend.onAdd = function () {
		var div = L.DomUtil.create("div", "mw-panel mw-legend");
		if (mode === "bucket") {
			var html = "";
			Object.keys(bucketColors).forEach(function (b) {
				html += '<div><i style="background:' + bucketColors[b] + '"></i>' + esc(b) + '</div>';
			});
			div.innerHTML = html;
		} else {
			div.innerHTML = '<div><i style="background:' + CROSS_COLOR + '"></i>cross-dataset link (&ge;2 sources)</div>'
				+ '<div><i style="background:' + SINGLE_COLOR + '"></i>single-source entity</div>'
				+ '<div class="muted" style="margin-top:4px">marker size = records merged</div>';
		}
		return div;
	};
	legend.addTo(map);
}
</script>
</body>
</html>
`
}
