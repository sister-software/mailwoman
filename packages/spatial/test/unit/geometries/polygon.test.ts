import type { LineStringPath } from "@mailwoman/spatial"
import {
	geometryContains,
	isPolygonLiteral,
	isSolidPolygonPath,
	pointInPolygon,
	pointInRing,
	type PolygonPath,
	type PolygonLiteral,
} from "@mailwoman/spatial/geometries/polygon"
import { expect, test } from "vitest"

const SOLID: PolygonLiteral = {
	type: "Polygon",
	coordinates: [
		[
			[100, 0],
			[101, 0],
			[101, 1],
			[100, 1],
			[100, 0],
		],
	],
}

test("isPolygonLiteral: only a {type:'Polygon', coordinates: []} object qualifies", () => {
	expect(isPolygonLiteral(SOLID)).toBe(true)
	expect(isPolygonLiteral({ type: "Point", coordinates: [0, 0] })).toBe(false)
	expect(isPolygonLiteral({ type: "Polygon" })).toBe(false)
	expect(isPolygonLiteral(null)).toBe(false)
	expect(isPolygonLiteral("Polygon")).toBe(false)
})

test("isSolidPolygonPath: one ring = solid, more rings = has holes", () => {
	expect(isSolidPolygonPath(SOLID)).toBe(true)

	const withHole: PolygonLiteral<PolygonPath> = {
		type: "Polygon",
		coordinates: [SOLID.coordinates[0]!, SOLID.coordinates[0]!],
	}

	expect(isSolidPolygonPath(withHole)).toBe(false)
})

const SQUARE: LineStringPath = [
	[0, 0],
	[0, 1],
	[1, 1],
	[1, 0],
	[0, 0],
]

test("pointInRing: inside vs outside a simple ring (ray-cast even-odd)", () => {
	expect(pointInRing(0.5, 0.5, SQUARE)).toBe(true)
	expect(pointInRing(2, 0.5, SQUARE)).toBe(false)
	expect(pointInRing(-1, 0.5, SQUARE)).toBe(false)
	expect(pointInRing(0.5, 2, SQUARE)).toBe(false)
})

test("PointInPolygon: a hole punches a void (even-odd handles holes without orientation rules)", () => {
	const outer: LineStringPath = [
		[0, 0],
		[0, 10],
		[10, 10],
		[10, 0],
		[0, 0],
	]

	const hole: LineStringPath = [
		[4, 4],
		[4, 6],
		[6, 6],
		[6, 4],
		[4, 4],
	]

	expect(pointInPolygon(1, 1, [outer, hole])).toBe(true)

	expect(pointInPolygon(5, 5, [outer, hole])).toBe(false)

	expect(pointInPolygon(20, 20, [outer, hole])).toBe(false)
})

test("GeometryContains: Polygon / MultiPolygon test; non-areal and null geometry → null", () => {
	const polygon = { type: "Polygon" as const, coordinates: [SQUARE] }

	expect(geometryContains(polygon, 0.5, 0.5)).toBe(true)
	expect(geometryContains(polygon, 5, 5)).toBe(false)

	const multi = {
		type: "MultiPolygon" as const,
		coordinates: [
			[SQUARE],
			[
				[
					[10, 10],
					[10, 11],
					[11, 11],
					[11, 10],
					[10, 10],
				] as LineStringPath,
			],
		],
	}

	expect(geometryContains(multi, 0.5, 0.5)).toBe(true)
	expect(geometryContains(multi, 10.5, 10.5)).toBe(true)
	expect(geometryContains(multi, 5, 5)).toBe(false)

	expect(geometryContains({ type: "Point", coordinates: [0.5, 0.5] }, 0.5, 0.5)).toBeNull()
	expect(geometryContains(null, 0.5, 0.5)).toBeNull()
	expect(geometryContains(undefined, 0.5, 0.5)).toBeNull()
})
