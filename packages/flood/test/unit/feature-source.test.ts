/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { createGeodatabaseFeatureSource } from "@mailwoman/flood/sdk/ingest"
import { describe, expect, it, vi } from "vitest"

vi.mock("@mailwoman/spatial/tools/ogr", () => ({
	readOGRLayerIdentity: async () => ({
		epsg: 4326,
		featureCount: 5,
		layer: "features",
		fields: [],
		extent: { minX: -1, minY: 50, maxX: 1, maxY: 52 },
	}),
}))

describe("createGeodatabaseFeatureSource: the declared count", () => {
	it("is the layer's count when no limit is given", async () => {
		const source = await createGeodatabaseFeatureSource({ geodatabasePath: "/nowhere/flood.gdb" })

		expect(source.declaredFeatureCount).toBe(5)
	})

	it("is the limit when the limit is below the layer's count", async () => {
		const source = await createGeodatabaseFeatureSource({ geodatabasePath: "/nowhere/flood.gdb", limit: 3 })

		expect(source.declaredFeatureCount).toBe(3)
	})

	it("is clamped to the layer's count when the limit exceeds it, so a complete read is not a short one", async () => {
		const source = await createGeodatabaseFeatureSource({ geodatabasePath: "/nowhere/flood.gdb", limit: 1_000_000 })

		expect(source.declaredFeatureCount).toBe(5)
	})

	it("defers to a caller-supplied count for a range", async () => {
		const source = await createGeodatabaseFeatureSource({
			geodatabasePath: "/nowhere/flood.gdb",
			limit: 1_000_000,
			declaredFeatureCount: 2,
		})

		expect(source.declaredFeatureCount).toBe(2)
	})
})
