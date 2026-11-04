/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads and writes binary glTF (GLB) files: the JSON document, the binary chunk, and the accessors the city model
 *   and landmark converters read.
 */

import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"

const GLB_MAGIC = 0x46_54_6c_67
const JSON_CHUNK = 0x4e_4f_53_4a
const BIN_CHUNK = 0x00_4e_49_42

/**
 * glTF's component type codes for the accessors {@link readAccessor} decodes.
 */
export const GLTFComponentType = {
	UnsignedByte: 5121,
	UnsignedShort: 5123,
	UnsignedInt: 5125,
	Float: 5126,
} as const

const COMPONENT_BYTES: Readonly<Record<number, number>> = {
	[GLTFComponentType.UnsignedByte]: 1,
	[GLTFComponentType.UnsignedShort]: 2,
	[GLTFComponentType.UnsignedInt]: 4,
	[GLTFComponentType.Float]: 4,
}

/**
 * A glTF mesh primitive, with the fields the converters read.
 */
export interface GLTFPrimitive {
	attributes: Record<string, number>
	indices?: number
	mode?: number
	extensions?: Record<string, unknown> & {
		KHR_draco_mesh_compression?: { attributes: Record<string, number> }
	}
}

/**
 * A glTF document, with the fields the converters read or write.
 */
export interface GLTFDocument {
	asset?: { version: string; generator?: string }
	extensionsUsed?: string[]
	extensionsRequired?: string[]
	extensions?: Record<string, unknown> & { CESIUM_RTC?: { center: [number, number, number] } }
	scenes?: Array<{ nodes: number[] }>
	scene?: number
	nodes?: Array<Record<string, unknown>>
	meshes?: Array<{ primitives: GLTFPrimitive[] }>
	buffers?: Array<{ byteLength: number; uri?: string }>
	bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; target?: number }>
	accessors?: Array<{
		bufferView?: number
		byteOffset?: number
		componentType: number
		count: number
		type: string
		min?: number[]
		max?: number[]
	}>
	images?: Array<{ bufferView?: number; mimeType?: string; uri?: string }>
}

/**
 * The JSON document and binary chunk of a GLB.
 *
 * @throws When the bytes are not a GLB.
 */
export function readGLB(glb: Uint8Array): { document: GLTFDocument; binary: Uint8Array } {
	const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)

	if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error("the glTF is not a GLB")

	const jsonLength = view.getUint32(12, true)

	if (view.getUint32(16, true) !== JSON_CHUNK) throw new Error("a GLB's first chunk is its JSON")

	const document = parseJSONStrict<GLTFDocument>(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)))
	const binaryAt = 20 + jsonLength

	const binary =
		binaryAt + 8 <= glb.byteLength && view.getUint32(binaryAt + 4, true) === BIN_CHUNK
			? glb.subarray(binaryAt + 8, binaryAt + 8 + view.getUint32(binaryAt, true))
			: new Uint8Array(0)

	return { document, binary }
}

/**
 * `length` rounded up to a multiple of `to`, the alignment GLB chunks and buffer views use.
 */
export function padded(length: number, to = 4): number {
	return Math.ceil(length / to) * to
}

/**
 * A GLB from a JSON document and binary chunk, each padded to 4 bytes as the format requires.
 */
export function writeGLB(document: GLTFDocument, binary: Uint8Array): Uint8Array {
	const json = new TextEncoder().encode(stringifyJSON(document))
	const jsonLength = padded(json.length)
	const binaryLength = padded(binary.length)
	const total = 12 + 8 + jsonLength + (binaryLength ? 8 + binaryLength : 0)
	const out = new Uint8Array(total)
	const view = new DataView(out.buffer)

	view.setUint32(0, GLB_MAGIC, true)
	view.setUint32(4, 2, true)
	view.setUint32(8, total, true)
	view.setUint32(12, jsonLength, true)
	view.setUint32(16, JSON_CHUNK, true)
	out.set(json, 20)
	// JSON is padded with spaces.
	out.fill(0x20, 20 + json.length, 20 + jsonLength)

	if (binaryLength) {
		const at = 20 + jsonLength

		view.setUint32(at, binaryLength, true)
		view.setUint32(at + 4, BIN_CHUNK, true)
		out.set(binary, at + 8)
	}

	return out
}

/**
 * Reads accessor `index` from a GLB's binary chunk as plain numbers, `components` per element.
 *
 * @throws When the accessor has no buffer view or a component type outside {@link GLTFComponentType}.
 */
export function readAccessor(document: GLTFDocument, binary: Uint8Array, index: number, components: number): number[] {
	const accessor = document.accessors?.[index]

	if (!accessor || accessor.bufferView == null) throw new Error(`accessor ${index} has no buffer view`)

	const view = document.bufferViews![accessor.bufferView]!
	const size = COMPONENT_BYTES[accessor.componentType]

	if (!size) throw new Error(`accessor ${index} has component type ${accessor.componentType}`)

	const stride = view.byteStride ?? size * components
	const data = new DataView(binary.buffer, binary.byteOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0))
	const values: number[] = []

	for (let element = 0; element < accessor.count; element++) {
		for (let component = 0; component < components; component++) {
			const at = element * stride + component * size

			switch (accessor.componentType) {
				case GLTFComponentType.Float:
					values.push(data.getFloat32(at, true))
					break
				case GLTFComponentType.UnsignedInt:
					values.push(data.getUint32(at, true))
					break
				case GLTFComponentType.UnsignedShort:
					values.push(data.getUint16(at, true))
					break
				default:
					values.push(data.getUint8(at))
			}
		}
	}

	return values
}
