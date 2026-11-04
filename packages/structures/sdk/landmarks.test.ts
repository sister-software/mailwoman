/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { readGLB, writeGLB, type GLTFDocument } from "#glb"
import { readLandmarkMesh } from "#landmarks"
import { convertLandmarkModel } from "#sdk/landmarks"

/**
 * A GLB of two triangle primitives: one triangle under a node translated 10 up and scaled by 2,
 * and one triangle that repeats a vertex of the first in world space, under an untransformed node.
 */
function twoPrimitiveGLB(): Uint8Array {
	const first = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
	// (0, 10, 0) is the first triangle's first vertex after its node's transform.
	const second = new Float32Array([0, 10, 0, 2, 12, 0, -4, 30, 0])
	const binary = new Uint8Array(first.byteLength + second.byteLength)

	binary.set(new Uint8Array(first.buffer), 0)
	binary.set(new Uint8Array(second.buffer), first.byteLength)

	const document: GLTFDocument = {
		asset: { version: "2.0" },
		scenes: [{ nodes: [0, 1] }],
		nodes: [
			{ mesh: 0, translation: [0, 10, 0], scale: [2, 2, 2] },
			{ mesh: 1, children: [] },
		],
		meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }, { primitives: [{ attributes: { POSITION: 1 } }] }],
		buffers: [{ byteLength: binary.byteLength }],
		bufferViews: [
			{ buffer: 0, byteOffset: 0, byteLength: first.byteLength },
			{ buffer: 0, byteOffset: first.byteLength, byteLength: second.byteLength },
		],
		accessors: [
			{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
			{ bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
		],
	}

	return writeGLB(document, binary)
}

describe("convertLandmarkModel", () => {
	it("applies node transforms, joins equal positions, and scales the result to the height with its base at zero", () => {
		const converted = convertLandmarkModel(twoPrimitiveGLB(), 40)

		expect(converted.sourcePrimitives).toBe(2)
		expect(converted.sourceVertices).toBe(6)
		expect(converted.vertices).toBe(5)
		expect(converted.triangles).toBe(2)
		// World heights run from 10 to 30, so the source is 20 tall and the scale is 2.
		expect(converted.sourceHeight).toBe(20)
		expect(converted.min).toEqual([-6, 0, 0])
		expect(converted.max).toEqual([6, 40, 0])

		const { document, binary } = readGLB(converted.glb)

		expect(document.meshes).toHaveLength(1)
		expect(document.meshes![0]!.primitives[0]!.attributes).toEqual({ POSITION: 0 })

		const positions = new Float32Array(binary.slice(0, 5 * 12).buffer)
		const indices = new Uint32Array(binary.slice(5 * 12, 5 * 12 + 6 * 4).buffer)

		// The horizontal center, x = -1, moves to the origin before the scale.
		expect(Array.from(positions.subarray(0, 3))).toEqual([2, 0, 0])
		expect([...indices]).toEqual([0, 1, 2, 0, 3, 4])
	})

	it("reads back through readLandmarkMesh with glTF's up axis as the map's z", () => {
		const mesh = readLandmarkMesh(convertLandmarkModel(twoPrimitiveGLB(), 40).glb)

		expect(mesh.positions).toHaveLength(15)
		expect(Math.max(...mesh.positions.filter((_, i) => i % 3 === 2))).toBe(40)
		expect([...mesh.indices]).toEqual([0, 1, 2, 0, 3, 4])
	})

	it("refuses a primitive that is not a triangle list", () => {
		const { document, binary } = readGLB(twoPrimitiveGLB())

		document.meshes![1]!.primitives[0]!.mode = 1

		expect(() => convertLandmarkModel(writeGLB(document, binary), 40)).toThrow(/mode 1/)
	})
})
