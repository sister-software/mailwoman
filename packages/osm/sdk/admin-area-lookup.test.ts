/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { ParsedGeometry } from "@mailwoman/spatial"
import { describe, expect, it } from "vitest"

import { createAdminAreaLookup } from "#sdk/admin-area-lookup"
import type { OSMAdminArea } from "#sdk/extract/boundary"

function square(name: string, minLon: number, minLat: number, size: number): OSMAdminArea {
	const geometry = {
		type: "Polygon",
		coordinates: [
			[
				[minLon, minLat],
				[minLon + size, minLat],
				[minLon + size, minLat + size],
				[minLon, minLat + size],
				[minLon, minLat],
			],
		],
	} as ParsedGeometry

	return { name, adminLevel: "9", osmID: name, geometry }
}

describe("createAdminAreaLookup", () => {
	it("names the area containing a point and nothing outside every area", () => {
		const lookup = createAdminAreaLookup([square("Novi Sad", 19.8, 45.2, 0.1), square("Zrenjanin", 20.3, 45.3, 0.1)])

		expect(lookup(19.85, 45.25)?.name).toBe("Novi Sad")
		expect(lookup(20.35, 45.35)?.name).toBe("Zrenjanin")
		expect(lookup(20, 45)).toBeNull()
	})

	it("prefers the smaller of two nested areas", () => {
		const lookup = createAdminAreaLookup([square("Municipality", 20, 44, 0.5), square("Village", 20.1, 44.1, 0.05)])

		expect(lookup(20.12, 44.12)?.name).toBe("Village")
		expect(lookup(20.4, 44.4)?.name).toBe("Municipality")
	})

	it("finds an area that spans several grid cells from a point in any of them", () => {
		const lookup = createAdminAreaLookup([square("Large", 10, 10, 1)])

		expect(lookup(10.05, 10.05)?.name).toBe("Large")
		expect(lookup(10.95, 10.95)?.name).toBe("Large")
	})
})
