// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import blockPalette from "@mailwoman/structures/data/facade/block-palette.json" with { type: "json" }
import { expect, test } from "vitest"

import { decodeBuildingTile, ROOF_STRIDE, unitMeters, WALL_STRIDE, wallRuns } from "#scene/compact-buildings/decode"

interface RecordSpec {
	height: number
	eave: number
	base?: number
	wallColor?: number
	district?: number
	floors?: number
	roofShape?: number
	flags?: number
	edgeFlags?: number[]
	style?: number[]
	rings: Array<Array<[number, number]>>
	/**
	 * Roof vertices: x and y in tile units and the height in decimeters.
	 */
	roof?: Array<[number, number, number]>
	triangles: number[]
}

/**
 * One record in the layout `hrt_profile::building_buffers` writes.
 */
function record(spec: RecordSpec): number[] {
	const bytes: number[] = []

	const u8 = (value: number) => {
		bytes.push(value & 0xff)
	}

	const u16 = (value: number) => {
		u8(value)
		u8(value >> 8)
	}

	const u32 = (value: number) => {
		u16(value & 0xff_ff)
		u16(value >>> 16)
	}

	const i16 = (value: number) => {
		u16(value < 0 ? value + 0x1_00_00 : value)
	}

	bytes.push(...new Uint8Array(new Float64Array([42]).buffer))
	u16(spec.height)
	u16(spec.eave)
	u16(spec.base ?? 0)
	u32(spec.wallColor ?? 0)
	u32(0)
	u8(spec.district ?? 0)
	u8(spec.floors ?? 0)
	u8(spec.roofShape ?? 0)
	u8(spec.flags ?? 0)

	for (let index = 0; index < 16; index++) {
		u8(spec.style?.[index] ?? 0xff)
	}

	u8(spec.rings.length)

	for (const ring of spec.rings) {
		u16(ring.length)
	}

	for (const [x, y] of spec.rings.flat()) {
		i16(x)
		i16(y)
	}

	for (let edge = 0; edge < (spec.rings[0]?.length ?? 0); edge++) {
		u8(spec.edgeFlags?.[edge] ?? 3)
	}

	u16(spec.roof?.length ?? 0)

	for (const [x, y, z] of spec.roof ?? []) {
		i16(x)
		i16(y)
		u16(z)
	}

	u16(spec.triangles.length / 3)

	for (const index of spec.triangles) {
		u16(index)
	}

	return bytes
}

function tile(...records: number[][]): ArrayBuffer {
	const body = [..."MWB2"].map((c) => c.charCodeAt(0))

	body.push(records.length, 0, 0, 0)

	for (const r of records) {
		body.push(...r)
	}

	return new Uint8Array(body).buffer
}

const square: Array<[number, number]> = [
	[100, 100],
	[200, 100],
	[200, 150],
	[100, 150],
]

test("a flat building yields one wall per edge and its roof triangles at its height", () => {
	const decoded = decodeBuildingTile(
		tile(record({ height: 123, eave: 123, floors: 4, rings: [square], triangles: [0, 1, 2, 0, 2, 3] })),
		6000
	)

	expect(decoded.buildings).toBe(1)
	expect(decoded.wallCount).toBe(4)
	expect(decoded.walls.byteLength).toBe(4 * WALL_STRIDE)
	const walls = new DataView(decoded.walls)
	// The last edge closes the ring from (100, 150) back to (100, 100).
	expect([walls.getInt16(3 * WALL_STRIDE, true), walls.getInt16(3 * WALL_STRIDE + 6, true)]).toEqual([100, 100])
	expect(walls.getUint16(10, true)).toBe(123)
	expect(walls.getUint8(15)).toBe(4)
	expect(decoded.roofVertexCount).toBe(4)
	expect(new DataView(decoded.roofVertices).getUint16(4, true)).toBe(123)
	expect([...decoded.roofIndices]).toEqual([0, 1, 2, 0, 2, 3])
})

test("a building without a height stands 10 m above its base, and a tagged color tints its walls", () => {
	const decoded = decodeBuildingTile(
		tile(
			record({
				height: 0xff_ff,
				eave: 0xff_ff,
				base: 30,
				wallColor: 0x80_00_00_00 | 0xff_00_00,
				rings: [square],
				triangles: [0, 1, 2],
			})
		),
		6000
	)

	const walls = new DataView(decoded.walls)

	expect(walls.getUint16(8, true)).toBe(30)
	expect(walls.getUint16(10, true)).toBe(130)
	// Red mixed halfway toward the near-white base color.
	expect(walls.getUint8(12)).toBeGreaterThan(walls.getUint8(13))
})

test("a pitched roof gives each face its own vertices with walls ending at the eaves", () => {
	const decoded = decodeBuildingTile(
		tile(
			record({
				height: 100,
				eave: 70,
				roofShape: 1,
				rings: [square],
				roof: [
					[100, 125, 100],
					[200, 125, 90],
				],
				triangles: [0, 1, 5, 0, 5, 4, 2, 3, 4, 2, 4, 5, 3, 0, 4, 1, 2, 5],
			})
		),
		6000
	)

	const roof = new DataView(decoded.roofVertices)

	expect(decoded.roofVertexCount).toBe(18)
	expect(new DataView(decoded.walls).getUint16(10, true)).toBe(70)
	// Each roof vertex keeps its own height: the first face's third corner is roof vertex 5 at 9 m.
	expect(roof.getUint16(2 * ROOF_STRIDE + 4, true)).toBe(90)
	// The second face's third corner is roof vertex 4 at 10 m.
	expect(roof.getUint16(5 * ROOF_STRIDE + 4, true)).toBe(100)
	expect(roof.getUint16(4, true)).toBe(70)
})

test("a truncated or foreign tile throws", () => {
	expect(() => decodeBuildingTile(new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0]).buffer, 0)).toThrow(/MWB2/u)
	const whole = new Uint8Array(tile(record({ height: 10, eave: 10, rings: [square], triangles: [0, 1, 2] })))
	// DataView throws a RangeError for a read past the end of the tile.
	expect(() => decodeBuildingTile(whole.slice(0, -2).buffer, 0)).toThrow(RangeError)
})

test("each wall carries its edge flags, the building flags and its straight run's length and start", () => {
	// A rectangle whose south side is split by a vertex at (150, 150): edges east, south, south and west.
	const split: Array<[number, number]> = [
		[100, 100],
		[200, 100],
		[200, 150],
		[150, 150],
		[100, 150],
	]

	const decoded = decodeBuildingTile(
		tile(
			record({
				height: 100,
				eave: 100,
				flags: 0b101,
				edgeFlags: [3, 1, 0b100, 0, 2],
				rings: [split],
				triangles: [0, 1, 2],
			})
		),
		6000
	)

	const walls = new DataView(decoded.walls)
	const unit = unitMeters(6000)
	const decimeters = (units: number) => Math.round(units * unit * 10)

	expect([0, 1, 2, 3, 4].map((wall) => walls.getUint8(wall * WALL_STRIDE + 20))).toEqual([3, 1, 0b100, 0, 2])
	expect(walls.getUint8(21)).toBe(0b101)
	// The two south edges form one 100-unit run, and the second starts 50 units along it.
	expect(walls.getUint16(2 * WALL_STRIDE + 16, true)).toBe(decimeters(100))
	expect(walls.getUint16(2 * WALL_STRIDE + 18, true)).toBe(0)
	expect(walls.getUint16(3 * WALL_STRIDE + 16, true)).toBe(decimeters(100))
	expect(walls.getUint16(3 * WALL_STRIDE + 18, true)).toBe(decimeters(50))
	// The east edge is its own 50-unit run.
	expect(walls.getUint16(1 * WALL_STRIDE + 16, true)).toBe(decimeters(50))
})

test("a resolved style colors the walls from the block palette and carries the window layout", () => {
	// Palette indexes 0 (white concrete) for the walls, 1 for trim, 3 for glass and 7 for the roof.
	// Category 4, archetype 6 and a shopfront (1).
	// Windows 2 m wide between 1 m piers and 1 m corners, on 4 m storeys, with windows and a parapet.
	const style = [0, 1, 2, 3, 4, 0xff, 6, 7, 4, 6, 1, 2, 1, 1, 4, 0b11]

	const decoded = decodeBuildingTile(
		tile(record({ height: 100, eave: 100, wallColor: 0x80_ff_00_00, style, rings: [square], triangles: [0, 1, 2] })),
		6000
	)

	const walls = new DataView(decoded.walls)
	const palette = blockPalette.blocks

	// The resolved wall block wins over the tagged red.
	expect([walls.getUint8(12), walls.getUint8(13), walls.getUint8(14)]).toEqual(palette[0]!.rgb)
	expect([walls.getUint8(22), walls.getUint8(23)]).toEqual([6, 1])
	expect([walls.getUint8(24), walls.getUint8(25), walls.getUint8(26)]).toEqual(palette[3]!.rgb)
	expect(walls.getUint8(27)).toBe(4)
	expect([walls.getUint8(28), walls.getUint8(29), walls.getUint8(30)]).toEqual(palette[1]!.rgb)
	expect(walls.getUint8(31)).toBe(0b11)
	expect([walls.getUint8(32), walls.getUint8(33), walls.getUint8(34), walls.getUint8(35)]).toEqual([2, 1, 1, 4])
	const roof = new DataView(decoded.roofVertices)
	expect([roof.getUint8(8), roof.getUint8(9), roof.getUint8(10)]).toEqual(palette[7]!.rgb)
})

test("a ring that starts part way along a wall joins its last run to its first", () => {
	// The ring starts half way along its north side, so the last edge continues the first.
	const runs = wallRuns([150, 200, 200, 100, 100], [100, 100, 150, 150, 100])
	// Edge 4 (100,100)→(150,100) runs before edge 0 (150,100)→(200,100) in one 100-unit run.
	expect(runs.length[0]).toBe(100)
	expect(runs.length[4]).toBe(100)
	expect(runs.offset[4]).toBe(0)
	expect(runs.offset[0]).toBe(50)
})

test("a tile unit near the equator is about 0.3 m and shrinks toward the poles", () => {
	expect(unitMeters(8191)).toBeCloseTo(0.2986, 3)
	expect(unitMeters(2000)).toBeLessThan(unitMeters(6000))
})
