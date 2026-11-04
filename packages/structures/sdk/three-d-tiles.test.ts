/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import { describe, expect, it } from "vitest"

import { convertB3dm, convertTilesetJSON, limitTextureEdge } from "#sdk/three-d-tiles"

/**
 * The parts of a converted glTF document the tests read.
 */
interface ConvertedDocument {
	extensionsUsed: string[]
	extensionsRequired?: string[]
	extensions?: {
		EXT_structural_metadata?: {
			propertyTables: Array<{ count: number; properties: { gml_id: { values: number; stringOffsets: number } } }>
		}
	}
	nodes: unknown[]
	scenes: Array<{ nodes: number[] }>
	meshes: Array<{
		primitives: Array<{
			attributes: Record<string, number>
			extensions: {
				KHR_draco_mesh_compression: { attributes: Record<string, number> }
				EXT_mesh_features: unknown
			}
		}>
	}>
	bufferViews: Array<{ byteOffset: number; byteLength: number }>
}

function glb(document: object, binary: Uint8Array): Uint8Array {
	const json = new TextEncoder().encode(stringifyJSON(document))
	const jsonLength = Math.ceil(json.length / 4) * 4
	const binaryLength = Math.ceil(binary.length / 4) * 4
	const out = new Uint8Array(12 + 8 + jsonLength + 8 + binaryLength)
	const view = new DataView(out.buffer)

	view.setUint32(0, 0x46_54_6c_67, true)
	view.setUint32(4, 2, true)
	view.setUint32(8, out.length, true)
	view.setUint32(12, jsonLength, true)
	view.setUint32(16, 0x4e_4f_53_4a, true)
	out.set(json, 20)
	out.fill(0x20, 20 + json.length, 20 + jsonLength)
	view.setUint32(20 + jsonLength, binaryLength, true)
	view.setUint32(24 + jsonLength, 0x00_4e_49_42, true)
	out.set(binary, 28 + jsonLength)

	return out
}

function b3dm(featureTable: object, batchTable: object, body: Uint8Array): Uint8Array {
	const pad = (text: string) => new TextEncoder().encode(text.padEnd(Math.ceil(text.length / 8) * 8, " "))
	const feature = pad(stringifyJSON(featureTable))
	const batch = pad(stringifyJSON(batchTable))
	const out = new Uint8Array(28 + feature.length + batch.length + body.length)
	const view = new DataView(out.buffer)

	out.set(new TextEncoder().encode("b3dm"), 0)
	view.setUint32(4, 1, true)
	view.setUint32(8, out.length, true)
	view.setUint32(12, feature.length, true)
	view.setUint32(20, batch.length, true)
	out.set(feature, 28)
	out.set(batch, 28 + feature.length)
	out.set(body, 28 + feature.length + batch.length)

	return out
}

function readJSON(converted: Uint8Array): ConvertedDocument {
	const view = new DataView(converted.buffer, converted.byteOffset)

	return parseJSONStrict<ConvertedDocument>(
		new TextDecoder().decode(converted.subarray(20, 20 + view.getUint32(12, true)))
	)
}

describe("convertB3dm", () => {
	const source = glb(
		{
			asset: { version: "2.0" },
			extensionsUsed: ["CESIUM_RTC", "KHR_draco_mesh_compression"],
			extensionsRequired: ["CESIUM_RTC", "KHR_draco_mesh_compression"],
			extensions: { CESIUM_RTC: { center: [1, 2, 3] } },
			scene: 0,
			scenes: [{ nodes: [0] }],
			nodes: [{ mesh: 0 }],
			meshes: [
				{
					primitives: [
						{
							attributes: { POSITION: 0, _BATCHID: 1 },
							extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0, _BATCHID: 1 } } },
						},
					],
				},
			],
			buffers: [{ byteLength: 4 }],
			bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }],
		},
		new Uint8Array([9, 9, 9, 9])
	)

	it("moves the tile center into a root node, renames the batch id and keeps only the building ids", () => {
		const converted = convertB3dm(
			b3dm({ BATCH_LENGTH: 2 }, { gml_id: ["bldg_a", "bldg_bc"], "bldg:usage": ["x", "y"] }, source)
		)

		const json = readJSON(converted)
		const primitive = json.meshes[0]!.primitives[0]!

		expect(json.extensionsUsed).toEqual(["KHR_draco_mesh_compression", "EXT_mesh_features", "EXT_structural_metadata"])
		expect(json.extensionsRequired).toEqual(["KHR_draco_mesh_compression"])
		// ECEF (1, 2, 3) is the y-up glTF translation (1, 3, -2).
		expect(json.nodes[1]).toEqual({ name: "rtc", translation: [1, 3, -2], children: [0] })
		expect(json.scenes[0]!.nodes).toEqual([1])
		expect(Object.keys(primitive.attributes)).toEqual(["POSITION", "_FEATURE_ID_0"])
		expect(primitive.extensions.KHR_draco_mesh_compression.attributes).toEqual({ POSITION: 0, _FEATURE_ID_0: 1 })

		expect(primitive.extensions.EXT_mesh_features).toEqual({
			featureIds: [{ featureCount: 2, attribute: 0, propertyTable: 0 }],
		})

		const table = json.extensions!.EXT_structural_metadata!.propertyTables[0]!
		const values = json.bufferViews[table.properties.gml_id.values]!
		const offsets = json.bufferViews[table.properties.gml_id.stringOffsets]!
		const view = new DataView(converted.buffer, converted.byteOffset)
		const binaryAt = 20 + view.getUint32(12, true) + 8

		const text = new TextDecoder().decode(
			converted.subarray(binaryAt + values.byteOffset, binaryAt + values.byteOffset + values.byteLength)
		)

		expect(table.count).toBe(2)
		expect(text).toBe("bldg_abldg_bc")

		expect([
			...new Uint32Array(converted.slice(binaryAt + offsets.byteOffset, binaryAt + offsets.byteOffset + 12).buffer),
		]).toEqual([0, 6, 13])

		// The source's own geometry bytes are unchanged at the front of the binary chunk.
		expect([...converted.subarray(binaryAt, binaryAt + 4)]).toEqual([9, 9, 9, 9])
	})

	it("keeps feature ids without a property table when the batch table has no building ids", () => {
		const json = readJSON(convertB3dm(b3dm({ BATCH_LENGTH: 2 }, {}, source)))

		expect(json.meshes[0]!.primitives[0]!.extensions.EXT_mesh_features).toEqual({
			featureIds: [{ featureCount: 2, attribute: 0 }],
		})

		expect(json.extensions?.EXT_structural_metadata).toBeUndefined()
	})

	it("refuses bytes that are not a b3dm tile", () => {
		expect(() => convertB3dm(new Uint8Array(32))).toThrow(/b3dm/u)
	})
})

describe("limitTextureEdge", () => {
	it("scales a large image to the limit and moves the views after it", async () => {
		const { default: sharp } = await import("sharp")

		const image = new Uint8Array(
			await sharp({ create: { width: 64, height: 32, channels: 3, background: "#808080" } })
				.webp()
				.toBuffer()
		)

		const geometry = new Uint8Array([1, 2, 3, 4, 5])
		const binary = new Uint8Array(image.length + 8 + geometry.length)
		const geometryAt = Math.ceil(image.length / 8) * 8

		binary.set(image)
		binary.set(geometry, geometryAt)

		const source = glb(
			{
				asset: { version: "2.0" },
				images: [{ bufferView: 0, mimeType: "image/webp" }],
				buffers: [{ byteLength: binary.length }],
				bufferViews: [
					{ buffer: 0, byteOffset: 0, byteLength: image.length },
					{ buffer: 0, byteOffset: geometryAt, byteLength: geometry.length },
				],
			},
			binary
		)

		const limited = await limitTextureEdge(source, 16)
		const json = readJSON(limited)
		const view = new DataView(limited.buffer, limited.byteOffset)
		const binaryAt = 20 + view.getUint32(12, true) + 8

		const [imageView, geometryView] = json.bufferViews as [
			ConvertedDocument["bufferViews"][number],
			ConvertedDocument["bufferViews"][number],
		]

		const resized = limited.subarray(
			binaryAt + imageView.byteOffset,
			binaryAt + imageView.byteOffset + imageView.byteLength
		)

		const metadata = await sharp(resized).metadata()

		expect([metadata.width, metadata.height, metadata.format]).toEqual([16, 8, "webp"])
		expect(geometryView.byteOffset % 8).toBe(0)

		expect([
			...limited.subarray(binaryAt + geometryView.byteOffset, binaryAt + geometryView.byteOffset + geometry.length),
		]).toEqual([1, 2, 3, 4, 5])
	})

	it("returns the input when every image is within the limit", async () => {
		const source = glb({ asset: { version: "2.0" } }, new Uint8Array(0))

		expect(await limitTextureEdge(source, 16)).toBe(source)
	})
})

describe("convertTilesetJSON", () => {
	it("points every b3dm content at its glb, renames url to uri and lists the source paths", () => {
		const tileset = {
			asset: { version: "1.0" },
			root: { content: { url: "data/a.b3dm" }, children: [{ content: { uri: "data/b.b3dm" } }, {}] },
		}

		expect(convertTilesetJSON(tileset)).toEqual([
			{ path: "data/a.b3dm", leaf: false },
			{ path: "data/b.b3dm", leaf: true },
		])

		expect(tileset).toEqual({
			asset: { version: "1.1" },
			root: { content: { uri: "data/a.glb" }, children: [{ content: { uri: "data/b.glb" } }, {}] },
		})
	})
})
