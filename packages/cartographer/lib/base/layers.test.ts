/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */
import { describe, expect, test } from "vitest"

import { BaseLayers } from "#base/layers"

const indexOf = (id: string) => BaseLayers.findIndex((layer) => layer.id.endsWith(id))

describe("BaseLayers ocean order", () => {
	test("draws the opaque ocean fill over every land-use layer and the sub-national boundaries", () => {
		const oceanFill = indexOf("ocean-fill")

		const landuse = BaseLayers.flatMap((layer, index) =>
			layer.id.startsWith("landuse_") && index < oceanFill ? [index] : []
		)

		expect(oceanFill).toBeGreaterThan(-1)
		expect(BaseLayers.filter((layer) => layer.id.startsWith("landuse_")).length).toBeGreaterThan(0)
		// Piers and pedestrian plazas stand over the water, so Protomaps draws them above it.
		const overWater = new Set(["landuse_pier", "landuse_pedestrian"])

		for (const layer of BaseLayers.filter((entry) => entry.id.startsWith("landuse_") && !overWater.has(entry.id))) {
			expect(landuse).toContain(BaseLayers.indexOf(layer))
		}

		expect(indexOf("boundaries_band")).toBeLessThan(oceanFill)
		expect(BaseLayers.findIndex((layer) => layer.id === "boundaries")).toBeLessThan(oceanFill)
		expect(indexOf("boundaries_country")).toBeGreaterThan(oceanFill)
	})

	test("shades depth over the ocean fill and keeps the inland water fill", () => {
		expect(indexOf("ocean-depth")).toBe(indexOf("ocean-fill") + 1)

		const inland = BaseLayers.find((layer) => layer.id === "water")

		expect(inland?.type).toBe("fill")
		expect(inland?.type === "fill" ? inland.filter : null).toContainEqual(["!=", ["get", "kind"], "ocean"])
	})

	test("draws no relief shading on the sea floor", () => {
		expect(BaseLayers.some((layer) => layer.id.endsWith("ocean-floor"))).toBe(false)
	})
})
