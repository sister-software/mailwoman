/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Decodes one compact building tile into the buffers the GPU layer draws.
 *   `packages/hrt/crates/hrt-profile/src/building_buffers.rs` writes the tile and documents its record layout.
 */

import { GuideMapPalette } from "@mailwoman/cartographer/base/theme"

import { hexRGB } from "../meshes.ts"

/**
 * The first four bytes of a decompressed tile.
 */
const MAGIC = "MWB2"

/**
 * Bytes of a record's resolved style, each `0xFF` until the build resolves it.
 */
const STYLE_BYTES = 8

/**
 * Headings whose unit vectors' dot product exceeds this, about 14 degrees apart,
 * continue one straight wall run.
 * Arnis's `RUN_HEADING_COS`.
 */
const RUN_HEADING_COS = 0.97

/**
 * The `height` a building records when its source states no height or floor count.
 */
const UNKNOWN_HEIGHT = 0xff_ff

/**
 * The height in decimeters given to a building whose source states none, above its base.
 * It matches the 10 m the vector-tile extrusion style gives.
 */
const UNKNOWN_HEIGHT_DECIMETERS = 100

/**
 * Units per tile side.
 */
export const TILE_EXTENT = 8192

/**
 * The zoom of the tiles.
 */
export const TILE_ZOOM = 14

/**
 * Bytes per wall instance: `i16` x0, y0, x1, y1; `u16` base and top in decimeters;
 * `u8` red, green, blue and floors; `u16` the length of the straight wall run the
 * edge belongs to and the edge's start along it, in decimeters; `u8` the edge's flags
 * (bits 0 and 1 its facade class, bit 2 the front edge, bit 3 a street corner) and the building's
 * flags (bit 0 attached, bit 1 enclosed, bit 2 a street faces a wall); and two style bytes.
 */
export const WALL_STRIDE = 24

/**
 * What a wall edge faces, from bits 0 and 1 of its edge flags.
 *
 * `packages/hrt/crates/hrt-profile/src/facade_plan.rs` classifies the edges.
 */
export const FacadeClass = {
	Street: 0,
	Rear: 1,
	Party: 2,
	Open: 3,
} as const

export type FacadeClass = (typeof FacadeClass)[keyof typeof FacadeClass]

/**
 * The straight wall runs of a ring: for each edge, the run's length and the edge's
 * start along it, in the units the edge lengths are given in.
 *
 * Consecutive edges whose headings stay within {@link RUN_HEADING_COS} form one run,
 * so a vertex part way along a facade does not break its bays.
 * A ring whose first vertex lies part way along a wall joins its last run to its first,
 * as Arnis's `lay_out_facade_columns` does.
 * A zero-length edge joins the run it touches.
 */
export function wallRuns(xs: ArrayLike<number>, ys: ArrayLike<number>): { length: number[]; offset: number[] } {
	const count = xs.length

	const heading = (edge: number): [number, number] | null => {
		const next = (edge + 1) % count
		const dx = xs[next]! - xs[edge]!
		const dy = ys[next]! - ys[edge]!
		const length = Math.hypot(dx, dy)

		return length > 0 ? [dx / length, dy / length] : null
	}

	const parallel = (a: [number, number] | null, b: [number, number] | null) =>
		!a || !b || a[0] * b[0] + a[1] * b[1] > RUN_HEADING_COS

	const runs: number[][] = []
	let last: [number, number] | null = null

	for (let edge = 0; edge < count; edge++) {
		const here = heading(edge)

		if (!runs.length || !parallel(last, here)) {
			runs.push([])
		}

		runs.at(-1)!.push(edge)

		if (here) {
			last = here
		}
	}

	if (runs.length > 1) {
		let first: [number, number] | null = null

		for (let edge = 0; edge < count && !first; edge++) {
			first = heading(edge)
		}

		if (parallel(last, first)) {
			const tail = runs.pop()!
			runs[0] = [...tail, ...runs[0]!]
		}
	}

	const length = new Array<number>(count).fill(0)
	const offset = new Array<number>(count).fill(0)

	for (const run of runs) {
		let along = 0

		for (const edge of run) {
			offset[edge] = along
			const next = (edge + 1) % count
			along += Math.hypot(xs[next]! - xs[edge]!, ys[next]! - ys[edge]!)
		}

		for (const edge of run) {
			length[edge] = along
		}
	}

	return { length, offset }
}

/**
 * Bytes per roof vertex: `i16` x, y; `u16` z in decimeters and two bytes of padding;
 * `u8` red, green, blue and shade.
 */
export const ROOF_STRIDE = 12

/**
 * How far a tagged facade or roof color moves from the base building color, as in the vector-tile style.
 */
const TAGGED_COLOR_WEIGHT = 0.5

/**
 * How much darker than its walls an untagged roof is drawn, so a roof reads apart from the walls below it.
 */
const UNTAGGED_ROOF_SHADE = 0.93

/**
 * The direction light comes from in tile space (x east, y south, z up), for shading pitched roof faces.
 */
const ROOF_LIGHT = scaledToLengthOne([-0.4, -0.6, 0.7])

export interface DecodedBuildingTile {
	/**
	 * One instance per footprint edge, {@link WALL_STRIDE} bytes each.
	 */
	walls: ArrayBuffer
	wallCount: number
	/**
	 * Roof vertices, {@link ROOF_STRIDE} bytes each.
	 */
	roofVertices: ArrayBuffer
	roofVertexCount: number
	roofIndices: Uint32Array
	buildings: number
}

/**
 * A color as 0–255 channels.
 */
type RGB = readonly [number, number, number]

function scaledToLengthOne([x, y, z]: readonly [number, number, number]): [number, number, number] {
	const length = Math.hypot(x, y, z) || 1

	return [x / length, y / length, z / length]
}

/**
 * Converts an sRGB hex color to a triple of bytes, 0 to 255.
 */
export function byteRGB(hex: string): RGB {
	const [red, green, blue] = hexRGB(hex)

	return [Math.round(red * 255), Math.round(green * 255), Math.round(blue * 255)]
}

const BASE_COLOR = byteRGB(GuideMapPalette.building)
const DISTRICT_COLORS = GuideMapPalette.buildingDistricts.map(byteRGB)

/**
 * A tagged color (bit 31 set) mixed toward the base building color, or `null` when the bit is clear.
 */
function taggedColor(packed: number): RGB | null {
	if (!(packed & 0x80_00_00_00)) return null

	const mix = (base: number, tagged: number) => Math.round(base + (tagged - base) * TAGGED_COLOR_WEIGHT)

	return [
		mix(BASE_COLOR[0], (packed >> 16) & 0xff),
		mix(BASE_COLOR[1], (packed >> 8) & 0xff),
		mix(BASE_COLOR[2], packed & 0xff),
	]
}

/**
 * A color scaled by `factor`, such as a roof drawn a shade darker than its walls.
 */
function scaledColor([red, green, blue]: RGB, factor: number): RGB {
	return [Math.round(red * factor), Math.round(green * factor), Math.round(blue * factor)]
}

/**
 * Meters per tile unit at the latitude of z14 row `tileY`.
 */
export function unitMeters(tileY: number): number {
	const n = Math.PI - (2 * Math.PI * (tileY + 0.5)) / 2 ** TILE_ZOOM
	const latitude = Math.atan(Math.sinh(n))

	return (40_075_016.686 * Math.cos(latitude)) / 2 ** TILE_ZOOM / TILE_EXTENT
}

/**
 * Decodes a decompressed tile body for z14 row `tileY`, which sets the meters per
 * tile unit that pitched roofs are shaded with.
 *
 * @throws When the body does not start with `MWB2` or ends inside a record.
 */
export function decodeBuildingTile(bytes: ArrayBuffer, tileY: number): DecodedBuildingTile {
	const view = new DataView(bytes)
	const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))

	if (magic !== MAGIC) throw new Error(`a compact building tile starts with ${MAGIC}, not ${magic}`)

	const count = view.getUint32(4, true)
	const metersPerUnit = unitMeters(tileY)

	// Sized for the common case and grown as needed.
	let walls = new DataView(new ArrayBuffer(Math.max(64, count * 8 * WALL_STRIDE)))
	let roof = new DataView(new ArrayBuffer(Math.max(64, count * 8 * ROOF_STRIDE)))
	let indices = new Uint32Array(Math.max(16, count * 18))
	let wallCount = 0
	let roofVertexCount = 0
	let indexCount = 0

	const growWalls = (needed: number) => {
		if ((wallCount + needed) * WALL_STRIDE <= walls.byteLength) return
		const next = new DataView(new ArrayBuffer(Math.max(walls.byteLength * 2, (wallCount + needed) * WALL_STRIDE)))
		new Uint8Array(next.buffer).set(new Uint8Array(walls.buffer))
		walls = next
	}

	const growRoof = (vertices: number, newIndices: number) => {
		if ((roofVertexCount + vertices) * ROOF_STRIDE > roof.byteLength) {
			const next = new DataView(
				new ArrayBuffer(Math.max(roof.byteLength * 2, (roofVertexCount + vertices) * ROOF_STRIDE))
			)

			new Uint8Array(next.buffer).set(new Uint8Array(roof.buffer))
			roof = next
		}

		if (indexCount + newIndices > indices.length) {
			const next = new Uint32Array(Math.max(indices.length * 2, indexCount + newIndices))
			next.set(indices)
			indices = next
		}
	}

	const writeRoofVertex = (x: number, y: number, z: number, color: RGB, shade: number) => {
		const at = roofVertexCount * ROOF_STRIDE
		roof.setInt16(at, x, true)
		roof.setInt16(at + 2, y, true)
		roof.setUint16(at + 4, z, true)
		roof.setUint8(at + 8, color[0])
		roof.setUint8(at + 9, color[1])
		roof.setUint8(at + 10, color[2])
		roof.setUint8(at + 11, shade)

		roofVertexCount++
	}

	let at = 8

	for (let building = 0; building < count; building++) {
		// The record opens with the building's 8-byte id.
		// The layer draws without it.
		at += 8
		const height = view.getUint16(at, true)
		const eave = view.getUint16(at + 2, true)
		const base = view.getUint16(at + 4, true)
		const wallTag = view.getUint32(at + 6, true)
		const roofTag = view.getUint32(at + 10, true)
		const district = view.getUint8(at + 14)
		const floors = view.getUint8(at + 15)
		const buildingFlags = view.getUint8(at + 17)
		const style = new Uint8Array(bytes, at + 18, STYLE_BYTES)
		const ringCount = view.getUint8(at + 18 + STYLE_BYTES)
		at += 19 + STYLE_BYTES

		const ringSizes: number[] = []

		for (let ring = 0; ring < ringCount; ring++, at += 2) {
			ringSizes.push(view.getUint16(at, true))
		}

		const vertexCount = ringSizes.reduce((sum, size) => sum + size, 0)
		const xs = new Int16Array(vertexCount + 2)
		const ys = new Int16Array(vertexCount + 2)

		for (let vertex = 0; vertex < vertexCount; vertex++, at += 4) {
			xs[vertex] = view.getInt16(at, true)
			ys[vertex] = view.getInt16(at + 2, true)
		}

		const exterior = ringSizes[0] ?? 0
		const edgeFlags = new Uint8Array(bytes, at, exterior)
		at += exterior

		const ridgeCount = view.getUint8(at)
		at += 1

		for (let vertex = 0; vertex < ridgeCount; vertex++, at += 4) {
			xs[vertexCount + vertex] = view.getInt16(at, true)
			ys[vertexCount + vertex] = view.getInt16(at + 2, true)
		}

		const triangleCount = view.getUint16(at, true)
		at += 2
		const triangles = new Uint16Array(triangleCount * 3)

		for (let index = 0; index < triangles.length; index++, at += 2) {
			triangles[index] = view.getUint16(at, true)
		}

		const top = height === UNKNOWN_HEIGHT ? base + UNKNOWN_HEIGHT_DECIMETERS : height
		const wallTop = eave === UNKNOWN_HEIGHT ? top : eave

		const wallColor =
			taggedColor(wallTag) ?? taggedColor(roofTag) ?? (DISTRICT_COLORS[district] as RGB | undefined) ?? BASE_COLOR

		const roofColor = taggedColor(roofTag) ?? scaledColor(wallColor, UNTAGGED_ROOF_SHADE)

		growWalls(vertexCount)
		let ringStart = 0

		for (const [ring, size] of ringSizes.entries()) {
			const runs = wallRuns(xs.subarray(ringStart, ringStart + size), ys.subarray(ringStart, ringStart + size))

			for (let edge = 0; edge < size; edge++) {
				const from = ringStart + edge
				const to = ringStart + ((edge + 1) % size)
				const offset = wallCount * WALL_STRIDE
				walls.setInt16(offset, xs[from]!, true)
				walls.setInt16(offset + 2, ys[from]!, true)
				walls.setInt16(offset + 4, xs[to]!, true)
				walls.setInt16(offset + 6, ys[to]!, true)
				walls.setUint16(offset + 8, base, true)
				walls.setUint16(offset + 10, wallTop, true)
				walls.setUint8(offset + 12, wallColor[0])
				walls.setUint8(offset + 13, wallColor[1])
				walls.setUint8(offset + 14, wallColor[2])
				walls.setUint8(offset + 15, floors)
				walls.setUint16(offset + 16, Math.min(0xff_ff, Math.round(runs.length[edge]! * metersPerUnit * 10)), true)
				walls.setUint16(offset + 18, Math.min(0xff_ff, Math.round(runs.offset[edge]! * metersPerUnit * 10)), true)
				// A courtyard's walls are not classified, so they read as open.
				walls.setUint8(offset + 20, ring === 0 ? edgeFlags[edge]! : FacadeClass.Open)
				walls.setUint8(offset + 21, buildingFlags)
				walls.setUint8(offset + 22, style[0]!)
				walls.setUint8(offset + 23, style[1]!)

				wallCount++
			}

			ringStart += size
		}

		if (ridgeCount === 0) {
			// A flat roof shares its footprint vertices across triangles.
			growRoof(vertexCount, triangles.length)
			const first = roofVertexCount

			for (let vertex = 0; vertex < vertexCount; vertex++) {
				writeRoofVertex(xs[vertex]!, ys[vertex]!, wallTop, roofColor, 255)
			}

			for (const index of triangles) {
				indices[indexCount++] = first + index
			}
		} else {
			// A pitched roof's faces each take their own vertices, so each face is shaded by its own slope.
			growRoof(triangles.length, triangles.length)
			const z = (index: number) => (index >= vertexCount ? top : wallTop)

			for (let triangle = 0; triangle < triangleCount; triangle++) {
				const corners = [triangles[triangle * 3]!, triangles[triangle * 3 + 1]!, triangles[triangle * 3 + 2]!]

				const points = corners.map(
					(index) => [xs[index]! * metersPerUnit, ys[index]! * metersPerUnit, z(index) / 10] as const
				)

				const u = [0, 1, 2].map((axis) => points[1]![axis]! - points[0]![axis]!)
				const v = [0, 1, 2].map((axis) => points[2]![axis]! - points[0]![axis]!)

				const normal = scaledToLengthOne([
					u[1]! * v[2]! - u[2]! * v[1]!,
					u[2]! * v[0]! - u[0]! * v[2]!,
					u[0]! * v[1]! - u[1]! * v[0]!,
				])

				const lit = Math.abs(normal[0] * ROOF_LIGHT[0] + normal[1] * ROOF_LIGHT[1] + normal[2] * ROOF_LIGHT[2])
				const shade = Math.round(255 * (0.62 + 0.38 * lit))

				for (const index of corners) {
					indices[indexCount++] = roofVertexCount
					writeRoofVertex(xs[index]!, ys[index]!, z(index), roofColor, shade)
				}
			}
		}
	}

	if (at !== bytes.byteLength) {
		throw new Error(`a compact building tile of ${bytes.byteLength} bytes ended its records at byte ${at}`)
	}

	return {
		walls: walls.buffer.slice(0, wallCount * WALL_STRIDE),
		wallCount,
		roofVertices: roof.buffer.slice(0, roofVertexCount * ROOF_STRIDE),
		roofVertexCount,
		roofIndices: indices.slice(0, indexCount),
		buildings: count,
	}
}
