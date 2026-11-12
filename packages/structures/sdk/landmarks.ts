// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Converts a published landmark glTF into the single-mesh form Earth draws.
 *
 *   The map draws a landmark in one color with flat shading, like its buildings,
 *   so the conversion keeps only triangle positions.
 *   It applies every node transform, merges all triangle primitives into one, joins vertices
 *   with equal positions, and drops normals, texture coordinates, materials and images.
 *
 *   The result is scaled uniformly to the landmark's height, with the center of its
 *   horizontal extent at the origin and its lowest point at zero.
 *   Its axes stay glTF's: x east, y up, and z south before the landmark's yaw.
 */

import { GLTFComponentType, readAccessor, readGLB, writeGLB, type GLTFDocument } from "#glb"

const TRIANGLES = 4
const ARRAY_BUFFER = 34_962
const ELEMENT_ARRAY_BUFFER = 34_963

type Matrix = number[]

const IDENTITY: Matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/**
 * The rows and columns of a glTF node matrix.
 */
const MATRIX_ORDER = 4

/**
 * The product `a · b` of two column-major 4×4 matrices.
 */
function multiply(a: Matrix, b: Matrix): Matrix {
	const out = Array.from({ length: MATRIX_ORDER * MATRIX_ORDER }, () => 0)

	for (let column = 0; column < MATRIX_ORDER; column++) {
		for (let row = 0; row < MATRIX_ORDER; row++) {
			for (let k = 0; k < MATRIX_ORDER; k++) {
				out[column * MATRIX_ORDER + row]! += a[k * MATRIX_ORDER + row]! * b[column * MATRIX_ORDER + k]!
			}
		}
	}

	return out
}

interface GLTFNode {
	mesh?: number
	children?: number[]
	matrix?: number[]
	translation?: [number, number, number]
	rotation?: [number, number, number, number]
	scale?: [number, number, number]
}

/**
 * A node's local matrix, from its `matrix` or from translation, rotation and scale.
 */
function localMatrix(node: GLTFNode): Matrix {
	if (node.matrix) return node.matrix

	const [tx, ty, tz] = node.translation ?? [0, 0, 0]
	const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1]
	const [sx, sy, sz] = node.scale ?? [1, 1, 1]

	return [
		(1 - 2 * (y * y + z * z)) * sx,
		2 * (x * y + z * w) * sx,
		2 * (x * z - y * w) * sx,
		0,
		2 * (x * y - z * w) * sy,
		(1 - 2 * (x * x + z * z)) * sy,
		2 * (y * z + x * w) * sy,
		0,
		2 * (x * z + y * w) * sz,
		2 * (y * z - x * w) * sz,
		(1 - 2 * (x * x + y * y)) * sz,
		0,
		tx,
		ty,
		tz,
		1,
	]
}

/**
 * The converted model and what the conversion read and wrote.
 */
export interface LandmarkModelConversion {
	glb: Uint8Array
	sourcePrimitives: number
	sourceVertices: number
	vertices: number
	triangles: number
	/**
	 * The source's height before scaling, in its own units.
	 */
	sourceHeight: number
	/**
	 * The converted extent in meters: `[x, y, z]` minimum and maximum.
	 */
	min: [number, number, number]
	max: [number, number, number]
}

/**
 * Converts a binary glTF into one untextured triangle mesh scaled to `height` meters.
 *
 * @throws When the model holds a primitive other than a triangle list.
 * The conversion would otherwise leave that part of the model undrawn.
 */
export function convertLandmarkModel(glb: Uint8Array, height: number): LandmarkModelConversion {
	const { document, binary } = readGLB(glb)
	const nodes = (document.nodes ?? []) as GLTFNode[]
	const scene = document.scenes?.[document.scene ?? 0]
	const positions: number[] = []
	const indices: number[] = []
	const vertexIndex = new Map<string, number>()
	let sourcePrimitives = 0
	let sourceVertices = 0

	const visit = (nodeIndex: number, parent: Matrix) => {
		const node = nodes[nodeIndex]!
		const world = multiply(parent, localMatrix(node))

		if (node.mesh != null) {
			for (const primitive of document.meshes![node.mesh]!.primitives) {
				if ((primitive.mode ?? TRIANGLES) !== TRIANGLES) {
					throw new Error(`mesh ${node.mesh} has a primitive of mode ${primitive.mode}`)
				}

				const source = readAccessor(document, binary, primitive.attributes["POSITION"]!, 3)
				const count = source.length / 3

				const order =
					primitive.indices == null
						? Array.from({ length: count }, (_, i) => i)
						: readAccessor(document, binary, primitive.indices, 1)

				const remap: number[] = []

				sourcePrimitives++
				sourceVertices += count

				for (let i = 0; i < count; i++) {
					const [x, y, z] = [source[i * 3]!, source[i * 3 + 1]!, source[i * 3 + 2]!]
					const point = [0, 1, 2].map((r) => world[r]! * x + world[4 + r]! * y + world[8 + r]! * z + world[12 + r]!)
					const key = point.join(",")
					let index = vertexIndex.get(key)

					if (index == null) {
						index = positions.length / 3
						vertexIndex.set(key, index)
						positions.push(...point)
					}

					remap.push(index)
				}

				for (const index of order) {
					indices.push(remap[index]!)
				}
			}
		}

		for (const child of node.children ?? []) {
			visit(child, world)
		}
	}

	for (const root of scene?.nodes ?? nodes.map((_, i) => i)) {
		visit(root, IDENTITY)
	}

	if (!indices.length) throw new Error("the model holds no triangles")

	const min = [Infinity, Infinity, Infinity]
	const max = [-Infinity, -Infinity, -Infinity]

	for (let i = 0; i < positions.length; i++) {
		min[i % 3] = Math.min(min[i % 3]!, positions[i]!)
		max[i % 3] = Math.max(max[i % 3]!, positions[i]!)
	}

	const sourceHeight = max[1]! - min[1]!
	const scale = height / sourceHeight
	const origin = [(min[0]! + max[0]!) / 2, min[1]!, (min[2]! + max[2]!) / 2]
	const meters = new Float32Array(positions.length)

	for (let i = 0; i < positions.length; i++) {
		meters[i] = (positions[i]! - origin[i % 3]!) * scale
	}

	const scaledMin = [0, 1, 2].map((axis) => (min[axis]! - origin[axis]!) * scale) as [number, number, number]
	const scaledMax = [0, 1, 2].map((axis) => (max[axis]! - origin[axis]!) * scale) as [number, number, number]
	const indexArray = Uint32Array.from(indices)
	const out = new Uint8Array(meters.byteLength + indexArray.byteLength)

	out.set(new Uint8Array(meters.buffer), 0)
	out.set(new Uint8Array(indexArray.buffer), meters.byteLength)

	const converted: GLTFDocument = {
		asset: { version: "2.0", generator: "@mailwoman/structures landmark converter" },
		scene: 0,
		scenes: [{ nodes: [0] }],
		nodes: [{ mesh: 0 }],
		meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: TRIANGLES }] }],
		buffers: [{ byteLength: out.byteLength }],
		bufferViews: [
			{ buffer: 0, byteOffset: 0, byteLength: meters.byteLength, target: ARRAY_BUFFER },
			{ buffer: 0, byteOffset: meters.byteLength, byteLength: indexArray.byteLength, target: ELEMENT_ARRAY_BUFFER },
		],
		accessors: [
			{
				bufferView: 0,
				componentType: GLTFComponentType.Float,
				count: meters.length / 3,
				type: "VEC3",
				min: scaledMin,
				max: scaledMax,
			},
			{ bufferView: 1, componentType: GLTFComponentType.UnsignedInt, count: indexArray.length, type: "SCALAR" },
		],
	}

	return {
		glb: writeGLB(converted, out),
		sourcePrimitives,
		sourceVertices,
		vertices: meters.length / 3,
		triangles: indexArray.length / 3,
		sourceHeight,
		min: scaledMin,
		max: scaledMax,
	}
}
