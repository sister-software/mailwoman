// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Converts 3D Tiles 1.0 city models into the 3D Tiles 1.1 form Earth serves for every city source.
 *
 *   A 1.0 tile is a b3dm: a feature table, a batch table of per-building attributes, and a binary glTF.
 *   The 1.1 tile is that glTF, without the tables.
 *
 *   The conversion keeps the geometry and materials byte for byte and changes four things:
 *
 *   - The `CESIUM_RTC` center becomes the translation of a new root node, in glTF's y-up axes.
 *   - The `_BATCHID` vertex attribute becomes `_FEATURE_ID_0`, the feature id
 *     attribute of `EXT_mesh_features`.
 *   - The batch table is replaced by an `EXT_structural_metadata` property table holding
 *     one column, the source's building id (`gml_id` for a CityGML source).
 *     The map never reads the other columns, so they're dropped.
 *   - {@link limitTextureEdge} scales a texture larger than the tile's limit
 *     down to it, in the same image format.
 */

import { parseJSONStrict } from "@mailwoman/core/json"

import { padded, readGLB, writeGLB } from "#glb"

/**
 * The batch-table column that holds a source's building id.
 */
export const BUILDING_ID_COLUMN = "gml_id"

/**
 * A b3dm tile's parts.
 */
export interface B3dmParts {
	featureTable: Record<string, unknown>
	batchTable: Record<string, unknown>
	glb: Uint8Array
}

/**
 * Splits a b3dm tile into its feature table, batch table JSON and binary glTF.
 *
 * @throws When the bytes do not start with `b3dm`.
 */
export function readB3dm(bytes: Uint8Array): B3dmParts {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const magic = new TextDecoder().decode(bytes.subarray(0, 4))

	if (magic !== "b3dm") throw new Error(`a b3dm tile starts with b3dm, not ${magic}`)

	const [featureJSON, featureBinary, batchJSON, batchBinary] = [12, 16, 20, 24].map((at) =>
		view.getUint32(at, true)
	) as [number, number, number, number]

	const json = (from: number, length: number) =>
		length
			? parseJSONStrict<Record<string, unknown>>(new TextDecoder().decode(bytes.subarray(from, from + length)))
			: {}

	const batchAt = 28 + featureJSON + featureBinary

	return {
		featureTable: json(28, featureJSON),
		batchTable: json(batchAt, batchJSON),
		glb: bytes.subarray(batchAt + batchJSON + batchBinary, view.getUint32(8, true)),
	}
}

/**
 * The building ids of a batch table, or `null` when it holds none as a JSON array of the expected length.
 */
function buildingIDs(batchTable: Record<string, unknown>, count: number): string[] | null {
	const column = batchTable[BUILDING_ID_COLUMN]

	return Array.isArray(column) && column.length === count && column.every((value) => typeof value === "string")
		? (column as string[])
		: null
}

/**
 * Converts one b3dm tile into the 3D Tiles 1.1 binary glTF the tileset's content points to.
 */
export function convertB3dm(bytes: Uint8Array): Uint8Array {
	const { featureTable, batchTable, glb } = readB3dm(bytes)
	const { document, binary } = readGLB(glb)
	const featureCount = typeof featureTable["BATCH_LENGTH"] === "number" ? featureTable["BATCH_LENGTH"] : 0
	const used = new Set(document.extensionsUsed)
	const required = new Set(document.extensionsRequired)

	// The tile center moves from CESIUM_RTC into a root node. glTF is y-up and 3D Tiles z-up,
	// so ECEF (x, y, z) is the glTF translation (x, z, -y).
	const center = document.extensions?.CESIUM_RTC?.center

	if (center) {
		const nodes = (document.nodes ??= [])
		const scene = document.scenes?.[document.scene ?? 0]

		if (scene) {
			nodes.push({ name: "rtc", translation: [center[0], center[2], -center[1]], children: scene.nodes })
			scene.nodes = [nodes.length - 1]
		}

		delete document.extensions!.CESIUM_RTC
		used.delete("CESIUM_RTC")
		required.delete("CESIUM_RTC")
	}

	let out = binary

	if (featureCount > 0) {
		for (const primitive of document.meshes?.flatMap((mesh) => mesh.primitives) ?? []) {
			const draco = primitive.extensions?.KHR_draco_mesh_compression

			for (const attributes of [primitive.attributes, draco?.attributes]) {
				if (attributes && "_BATCHID" in attributes) {
					attributes["_FEATURE_ID_0"] = attributes["_BATCHID"]!
					delete attributes["_BATCHID"]
				}
			}

			if (!("_FEATURE_ID_0" in primitive.attributes)) continue

			primitive.extensions = {
				...primitive.extensions,
				EXT_mesh_features: {
					featureIds: [
						{ featureCount, attribute: 0, ...(buildingIDs(batchTable, featureCount) ? { propertyTable: 0 } : {}) },
					],
				},
			}

			used.add("EXT_mesh_features")
		}

		const ids = buildingIDs(batchTable, featureCount)

		if (ids && used.has("EXT_mesh_features")) {
			// The ids go into two new buffer views: the UTF-8 strings, and their offsets, each 8-byte aligned.
			const encoded = ids.map((id) => new TextEncoder().encode(id))
			const offsets = new Uint32Array(ids.length + 1)

			for (let index = 0; index < encoded.length; index++) {
				offsets[index + 1] = offsets[index]! + encoded[index]!.length
			}

			const valuesAt = padded(binary.length, 8)
			const offsetsAt = padded(valuesAt + offsets[ids.length]!, 8)
			const end = offsetsAt + offsets.byteLength

			out = new Uint8Array(end)
			out.set(binary)
			encoded.forEach((value, index) => out.set(value, valuesAt + offsets[index]!))
			out.set(new Uint8Array(offsets.buffer), offsetsAt)

			const views = (document.bufferViews ??= [])

			views.push({ buffer: 0, byteOffset: valuesAt, byteLength: offsets[ids.length]! })
			views.push({ buffer: 0, byteOffset: offsetsAt, byteLength: offsets.byteLength })
			const buffers = (document.buffers ??= [{ byteLength: 0 }])

			buffers[0]!.byteLength = padded(end)

			document.extensions = {
				...document.extensions,
				EXT_structural_metadata: {
					schema: {
						id: "building",
						classes: { building: { properties: { [BUILDING_ID_COLUMN]: { type: "STRING" } } } },
					},
					propertyTables: [
						{
							class: "building",
							count: featureCount,
							properties: {
								[BUILDING_ID_COLUMN]: {
									values: views.length - 2,
									stringOffsets: views.length - 1,
									stringOffsetType: "UINT32",
								},
							},
						},
					],
				},
			}

			used.add("EXT_structural_metadata")
		}
	}

	document.extensionsUsed = [...used]

	if (required.size) {
		document.extensionsRequired = [...required]
	} else {
		delete document.extensionsRequired
	}

	if (document.extensions && !Object.keys(document.extensions).length) {
		delete document.extensions
	}

	return writeGLB(document, out)
}

/**
 * The longest texture edge, in pixels, that a converted leaf tile keeps.
 *
 * The viewer's tile cache has a byte budget, and a decoded texture costs four
 * bytes per pixel plus a third more for its mipmaps.
 * A view near the ground refines to the leaf tiles of the whole visible area.
 *
 * The viewer also keeps the ancestors on each leaf's refinement path, so the leaves
 * and those ancestors must fit the budget together.
 */
export const MAX_TEXTURE_EDGE = 1024

/**
 * The longest texture edge, in pixels, that a converted tile with children keeps.
 *
 * A viewer shows such a tile only from farther away than its children, so it needs fewer texture pixels.
 */
export const INTERIOR_TEXTURE_EDGE = 512

/**
 * Scales every embedded image in a binary glTF so its longer edge is at most `maxEdge` pixels.
 *
 * An image keeps its format and aspect ratio.
 * The binary chunk is rebuilt with each buffer view 8-byte aligned.
 *
 * An accessor addresses bytes within its view, so every accessor keeps its offset.
 */
export async function limitTextureEdge(glb: Uint8Array, maxEdge = MAX_TEXTURE_EDGE): Promise<Uint8Array> {
	const { document, binary } = readGLB(glb)
	const views = document.bufferViews ?? []
	const replaced = new Map<number, Uint8Array>()
	const { default: sharp } = await import("sharp")

	for (const image of document.images ?? []) {
		if (typeof image.bufferView !== "number") continue

		const view = views[image.bufferView]!
		const at = view.byteOffset ?? 0
		const source = binary.subarray(at, at + view.byteLength)
		const decoder = sharp(source)
		const { width, height, format } = await decoder.metadata()

		if (!width || !height) throw new Error(`image in buffer view ${image.bufferView} has no readable size`)

		if (Math.max(width, height) <= maxEdge) continue

		const resized = await decoder
			.resize({ width: maxEdge, height: maxEdge, fit: "inside" })
			.toFormat(format as keyof import("sharp").FormatEnum)
			.toBuffer()

		replaced.set(image.bufferView, new Uint8Array(resized.buffer, resized.byteOffset, resized.byteLength))
	}

	if (!replaced.size) return glb

	const contents = views.map((view, index) => {
		const at = view.byteOffset ?? 0

		return replaced.get(index) ?? binary.subarray(at, at + view.byteLength)
	})

	let length = 0

	for (const content of contents) {
		length = padded(length, 8) + content.length
	}

	const out = new Uint8Array(padded(length))
	let cursor = 0

	contents.forEach((content, index) => {
		cursor = padded(cursor, 8)
		out.set(content, cursor)
		views[index] = { ...views[index]!, byteOffset: cursor, byteLength: content.length }
		cursor += content.length
	})

	document.buffers = [{ byteLength: out.length }]

	return writeGLB(document, out)
}

/**
 * A tile of a 3D Tiles tileset, as far as the conversion reads and rewrites it.
 */
export interface TilesetTile {
	content?: { uri?: string; url?: string }
	children?: TilesetTile[]
	[key: string]: unknown
}

/**
 * One content file a tileset references.
 */
export interface TilesetContent {
	/**
	 * The path relative to the tileset, as the source tileset writes it.
	 */
	path: string
	/**
	 * Whether the tile has no children, so a viewer shows it at the closest distances.
	 */
	leaf: boolean
}

/**
 * Rewrites a 1.0 tileset in place for its converted tiles: every b3dm content points to
 * the `.glb` beside it, `url` becomes `uri`, and the asset version becomes 1.1.
 *
 * Returns the contents the tileset references, in tree order.
 */
export function convertTilesetJSON(tileset: { asset: { version: string }; root: TilesetTile }): TilesetContent[] {
	const paths: TilesetContent[] = []

	const visit = (tile: TilesetTile) => {
		const content = tile.content

		if (content) {
			const uri = content.uri ?? content.url

			delete content.url

			if (uri) {
				content.uri = uri.replace(/\.b3dm$/u, ".glb")
				paths.push({ path: uri, leaf: !tile.children?.length })
			}
		}

		for (const child of tile.children ?? []) {
			visit(child)
		}
	}

	visit(tileset.root)
	tileset.asset.version = "1.1"

	return paths
}
