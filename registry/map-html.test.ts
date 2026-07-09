/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { toMapHTML } from "./map-html.ts"
import type { GeoJsonFeatureCollection } from "./types.ts"

function fc(features: GeoJsonFeatureCollection["features"]): GeoJsonFeatureCollection {
	return { type: "FeatureCollection", features }
}

function point(lon: number, lat: number, props: Record<string, unknown>): GeoJsonFeatureCollection["features"][number] {
	return { type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: props }
}

describe("toMapHTML", () => {
	it("returns a complete HTML document on the house stack: MapLibre (pinned + SRI) + Protomaps basemap", () => {
		const html = toMapHTML(
			fc([point(-97.7431, 30.2672, { entityID: "e1", recordCount: 2, sources: ["a", "b"], name: "Acme" })])
		)
		expect(html.startsWith("<!doctype html>")).toBe(true)
		expect(html.trimEnd().endsWith("</html>")).toBe(true)
		// MapLibre GL, not Leaflet, pinned with SRI.
		expect(html).toContain("maplibre-gl@5.24.0/dist/maplibre-gl.js")
		expect(html).toContain('integrity="sha384-')
		expect(html).not.toMatch(/leaflet/i)
		// The house Protomaps basemap-v4 vector source (CORS-aware tile-worker), not a raster tile URL.
		expect(html).toContain("https://tiles.sister.software/basemap-v4.json")
		// Glyphs + sprite from the CORS-enabled upstream Protomaps assets (house mirror isn't CORS-routed).
		expect(html).toContain("protomaps.github.io/basemaps-assets/fonts")
		expect(html).toContain("protomaps.github.io/basemaps-assets/sprites/v4/light")
		expect(html).not.toMatch(/tile\.openstreetmap\.org|raster/)
		expect(html).toContain("new maplibregl.Map(")
	})

	it("inlines a real Protomaps basemap (many generated layers) plus the entity circle layer", () => {
		const html = toMapHTML(fc([point(0, 0, { entityID: "e1", recordCount: 1 })]))
		// @protomaps/basemaps generates ~70 layer specs; they + our layer are inlined in the style.
		expect(html).toContain('"id":"mw-entities"')
		expect(html).toContain('"id":"earth"')
		expect(html).toContain('"basemap-v4"')
	})

	it("renders an empty collection as a friendly empty state, not a broken map", () => {
		const html = toMapHTML(fc([]))
		expect(html).toContain("No geocoded entities")
		expect(html).toContain("var BBOX = null") // no features → null bbox → page keeps its default view
	})

	it("escapes `</script>` inside record values so a string can't break out of the inlined data", () => {
		const html = toMapHTML(fc([point(0, 0, { entityID: "x", recordCount: 1, name: "</script><script>alert(1)" })]))
		expect(html).not.toContain("</script><script>alert(1)")
		expect(html).toContain("\\u003c/script")
	})

	it("auto-selects bucket coloring when any feature carries a `bucket`, else cross-dataset coloring", () => {
		const withBuckets = toMapHTML(
			fc([
				point(0, 0, { entityID: "a", recordCount: 1, bucket: "enrolled", sources: ["x"] }),
				point(1, 1, { entityID: "b", recordCount: 1, bucket: "eligible-not-enrolled", sources: ["y"] }),
			])
		)
		// Bucket labels render verbatim in the legend (neutral — straight from the data).
		expect(withBuckets).toContain("enrolled")
		expect(withBuckets).toContain("eligible-not-enrolled")
		// Each feature gets a precomputed `_color`.
		expect(withBuckets).toContain('"_color"')

		const noBuckets = toMapHTML(fc([point(0, 0, { entityID: "a", recordCount: 1, sources: ["x", "y"] })]))
		expect(noBuckets).toContain("cross-dataset link")
	})

	it("honors the flavor + title options", () => {
		const html = toMapHTML(fc([point(0, 0, { entityID: "a", recordCount: 1 })]), {
			title: "Coverage reconciliation",
			flavor: "dark",
		})
		expect(html).toContain("<title>Coverage reconciliation</title>")
		// A dark Protomaps flavor produces a dark background fill in the inlined style.
		expect(html).toMatch(/"background"/)
	})

	it("escapes the title in the document body too (not just the script)", () => {
		const html = toMapHTML(fc([]), { title: "<b>x</b>" })
		expect(html).toContain("<title>&lt;b&gt;x&lt;/b&gt;</title>")
	})
})
