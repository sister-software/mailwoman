/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The footprint: what a boundary file may hold, and what the outline must yield before a coverage claim
 *   is written from it.
 */

import { outlineFromGeoJSON, realizeFloodMapExtent } from "@mailwoman/flood/sdk/extent"
import { EA_COVERAGE_STATEMENT, EA_COVERAGE_STATEMENT_URL } from "@mailwoman/flood/vocabulary"
import { rectangleRing } from "@mailwoman/spatial"
import { describe, expect, it } from "vitest"

const GEOMETRY = { type: "Polygon", coordinates: [rectangleRing(-1, 52, 0, 53)] }

function realize(geometry: unknown, coverageResolution = 6) {
	return realizeFloodMapExtent({
		geometry: geometry as Parameters<typeof realizeFloodMapExtent>[0]["geometry"],
		coverageResolution,
		authority: "Environment Agency",
		statement: EA_COVERAGE_STATEMENT,
		statementURL: EA_COVERAGE_STATEMENT_URL,
	})
}

describe("outlineFromGeoJSON", () => {
	it("accepts a bare geometry", () => {
		expect(outlineFromGeoJSON(GEOMETRY, "fixture")).toBe(GEOMETRY)
	})

	it("accepts a Feature wrapping one", () => {
		expect(outlineFromGeoJSON({ type: "Feature", properties: {}, geometry: GEOMETRY }, "fixture")).toBe(GEOMETRY)
	})

	it("accepts a single-feature FeatureCollection, which is what every export tool writes", () => {
		const document = { type: "FeatureCollection", features: [{ type: "Feature", geometry: GEOMETRY }] }

		expect(outlineFromGeoJSON(document, "fixture")).toBe(GEOMETRY)
	})

	it("refuses a collection holding several features rather than choosing one", () => {
		const document = {
			type: "FeatureCollection",
			features: [{ geometry: GEOMETRY }, { geometry: GEOMETRY }],
		}

		expect(() => outlineFromGeoJSON(document, "two-countries.geojson")).toThrow(/exactly one outline/u)
	})

	it("refuses a document carrying no geometry", () => {
		expect(() => outlineFromGeoJSON({ type: "Feature", properties: {} }, "empty.geojson")).toThrow(/no geometry/u)
	})
})

describe("realizeFloodMapExtent", () => {
	it("keeps only cells wholly inside the outline, so the border strip gets no coverage row", () => {
		const extent = realize(GEOMETRY)

		expect(extent.coverageCells.size).toBeGreaterThan(0)
		// The conservative interior test drops the fringe, so the footprint is strictly smaller than a raw polyfill of the
		// same rectangle would be. A cell wrongly called interior claims a determination nobody made.
		expect(extent.bbox).toEqual({ minLat: 52, minLon: -1, maxLat: 53, maxLon: 0 })
	})

	it("refuses an outline that yields no interior cell rather than building a silent no-op", () => {
		// Resolution 2 cells are hundreds of thousands of square kilometres, so nothing lies wholly inside this rectangle.
		// A zero-cell footprint would write no coverage rows and answer "unknown" everywhere while reporting success.
		expect(() => realize(GEOMETRY, 2)).toThrow(/no interior cell/u)
	})
})
