// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { expect, test } from "vitest"

import { decodeBuildingTile, ROOF_STRIDE, unitMeters, WALL_STRIDE } from "#scene/compact-buildings/decode"

interface RecordSpec {
	height: number
	eave: number
	base?: number
	wallColor?: number
	district?: number
	floors?: number
	roofShape?: number
	rings: Array<Array<[number, number]>>
	ridge?: Array<[number, number]>
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
	u8(spec.rings.length)

	for (const ring of spec.rings) {
		u16(ring.length)
	}

	for (const [x, y] of spec.rings.flat()) {
		i16(x)
		i16(y)
	}

	u8(spec.ridge?.length ?? 0)

	for (const [x, y] of spec.ridge ?? []) {
		i16(x)
		i16(y)
	}

	u16(spec.triangles.length / 3)

	for (const index of spec.triangles) {
		u16(index)
	}

	return bytes
}

function tile(...records: number[][]): ArrayBuffer {
	const body = [..."MWB1"].map((c) => c.charCodeAt(0))

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
				ridge: [
					[100, 125],
					[200, 125],
				],
				triangles: [0, 1, 5, 0, 5, 4, 2, 3, 4, 2, 4, 5, 3, 0, 4, 1, 2, 5],
			})
		),
		6000
	)

	const roof = new DataView(decoded.roofVertices)

	expect(decoded.roofVertexCount).toBe(18)
	expect(new DataView(decoded.walls).getUint16(10, true)).toBe(70)
	// The third corner of the first face is ridge vertex 5, at the full height.
	expect(roof.getUint16(2 * ROOF_STRIDE + 4, true)).toBe(100)
	expect(roof.getUint16(4, true)).toBe(70)
})

test("a truncated or foreign tile throws", () => {
	expect(() => decodeBuildingTile(new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0]).buffer, 0)).toThrow(/MWB1/u)
	const whole = new Uint8Array(tile(record({ height: 10, eave: 10, rings: [square], triangles: [0, 1, 2] })))
	// DataView throws a RangeError for a read past the end of the tile.
	expect(() => decodeBuildingTile(whole.slice(0, -2).buffer, 0)).toThrow(RangeError)
})

test("a tile unit near the equator is about 0.3 m and shrinks toward the poles", () => {
	expect(unitMeters(8191)).toBeCloseTo(0.2986, 3)
	expect(unitMeters(2000)).toBeLessThan(unitMeters(6000))
})
