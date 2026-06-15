/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import { toMapHTML } from "./map-html.js"
import type { GeoJsonFeatureCollection } from "./types.js"

function fc(features: GeoJsonFeatureCollection["features"]): GeoJsonFeatureCollection {
	return { type: "FeatureCollection", features }
}

function point(lon: number, lat: number, props: Record<string, unknown>): GeoJsonFeatureCollection["features"][number] {
	return { type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: props }
}

describe("toMapHTML", () => {
	it("returns a complete, self-contained HTML document with Leaflet pinned + the data inlined", () => {
		const html = toMapHTML(
			fc([point(-97.7431, 30.2672, { entityId: "e1", recordCount: 2, sources: ["a", "b"], name: "Acme" })])
		)
		expect(html.startsWith("<!doctype html>")).toBe(true)
		expect(html.trimEnd().endsWith("</html>")).toBe(true)
		// Leaflet is pinned with Subresource-Integrity hashes.
		expect(html).toContain("leaflet@1.9.4/dist/leaflet.js")
		expect(html).toContain('integrity="sha256-')
		// The FeatureCollection is inlined (no fetch of an external data file).
		expect(html).toContain('"entityId":"e1"')
		expect(html).toContain("L.map(")
	})

	it("renders an empty collection as a friendly empty state, not a broken map", () => {
		const html = toMapHTML(fc([]))
		expect(html).toContain("No geocoded entities")
		expect(html).toContain("setView([20, 0], 2)")
	})

	it("escapes `</script>` inside record values so a malicious string can't break out of the inlined data", () => {
		const html = toMapHTML(fc([point(0, 0, { entityId: "x", recordCount: 1, name: "</script><script>alert(1)" })]))
		// The literal closing tag must NOT survive inside the data block.
		expect(html).not.toContain("</script><script>alert(1)")
		// It must be present in escaped < form instead.
		expect(html).toContain("\\u003c/script")
	})

	it("auto-selects bucket coloring when any feature carries a `bucket`, else cross-dataset coloring", () => {
		const withBuckets = toMapHTML(
			fc([
				point(0, 0, { entityId: "a", recordCount: 1, bucket: "enrolled", sources: ["x"] }),
				point(1, 1, { entityId: "b", recordCount: 1, bucket: "eligible-not-enrolled", sources: ["y"] }),
			])
		)
		expect(withBuckets).toContain('var mode = COLOR_BY === "auto"')
		// Bucket labels are rendered verbatim into the legend wiring (neutral — straight from the data).
		expect(withBuckets).toContain("enrolled")
		expect(withBuckets).toContain("eligible-not-enrolled")

		const noBuckets = toMapHTML(fc([point(0, 0, { entityId: "a", recordCount: 1, sources: ["x", "y"] })]))
		expect(noBuckets).toContain("cross-dataset link")
	})

	it("honors the title and basemap options; falls back to OSM for an unknown basemap", () => {
		const html = toMapHTML(fc([point(0, 0, { entityId: "a", recordCount: 1 })]), {
			title: "Coverage reconciliation",
			basemap: "carto-dark",
		})
		expect(html).toContain("<title>Coverage reconciliation</title>")
		expect(html).toContain("dark_all")

		// Unknown basemap → OSM default (the guard keeps a bad option from producing a broken tile URL).
		const fallback = toMapHTML(fc([point(0, 0, { entityId: "a", recordCount: 1 })]), {
			basemap: "nope" as never,
		})
		expect(fallback).toContain("tile.openstreetmap.org")
	})

	it("escapes the title in the document body too (not just the script)", () => {
		const html = toMapHTML(fc([]), { title: "<b>x</b>" })
		expect(html).toContain("<title>&lt;b&gt;x&lt;/b&gt;</title>")
	})
})
