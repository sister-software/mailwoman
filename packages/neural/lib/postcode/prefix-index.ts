/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { PostcodePrefixAncestor, PostcodePrefixNode } from "@mailwoman/core/resolver"

import { readFramedHeader, writeFramedHeader } from "#binary-frame"
import { dequantizeCoordinate, LAT_Q, LON_Q, quantizeCoordinate } from "#postcode/binary-resolver"

const MAGIC = 0x31_58_46_50
const KNOWN_SCHEMA_VERSION = 1

const FLAG_HAS_COORDINATE = 0b0000_0001
const FLAG_HAS_RADIUS = 0b0000_0010

const MAX_U8_LEN = 255

const MAX_EXACT_WOF_ID = Number.MAX_SAFE_INTEGER

/**
 * The licensing tier of the index's source, as defined in `docs/engineering/reference/layer-interface.mdx`.
 *
 * The header stores the tier so that a share-alike (ODbL) obligation stays with the artifact.
 */
export type PostcodePrefixTier = "shipped" | "build-local"

/**
 * The JSON header of a PFX1 postcode-prefix index.
 */
export interface PostcodePrefixHeader {
	/**
	 * The ISO country code the index was built for.
	 */
	country: string

	/**
	 * The sub-national scope slug and filename suffix, such as `"gb-esw"` for
	 * Code-Point Open or `"gb-ni"` for the BT districts.
	 *
	 * It separates files for one country that come from registers with different licenses and coverage.
	 */
	scope: string
	schemaVersion: 1

	/**
	 * The prefix granularities in the node table, such as `["outward"]` for GB
	 * or `["3"]` for US sectional centers.
	 */
	levels: readonly string[]

	/**
	 * The numbering authority that issued the prefixes.
	 *
	 * Prefixes come from the authority because gazetteer parents can place a
	 * ZIP in its mail processor's state.
	 */
	source: string

	/**
	 * The MD5 checksums of the source artifacts.
	 */
	sourceMD5s: string[]

	/**
	 * The ISO date the index was built.
	 */
	buildDate: string

	/**
	 * The licensing tier of the source.
	 */
	tier: PostcodePrefixTier

	/**
	 * The source license attribution.
	 * Keep it with every copy of the artifact.
	 */
	attribution: string

	/**
	 * What a missing prefix means for this file.
	 *
	 * A miss in a complete register means the prefix does not exist.
	 * A miss in a partial register may mean only that the prefix was not observed.
	 */
	coverageNote: string

	/**
	 * The emission bias magnitude.
	 *
	 * It stays absent until calibration measures a value.
	 * No consumer reads it.
	 */
	delta?: number
}

function ancestorKey(a: PostcodePrefixAncestor): string {
	return `${a.placetype}\0${a.wofID}\0${a.name}`
}

/**
 * Serializes a postcode-prefix index to PFX1 bytes.
 *
 * Every coordinate must have a `radiusP95Km` so that a coarse centroid is never read as a precise point.
 *
 * @throws On a duplicate prefix, a coordinate without a radius or a radius without
 * a coordinate, or a value too large for the format.
 */
export function serializePostcodePrefixIndex(
	header: PostcodePrefixHeader,
	nodes: readonly PostcodePrefixNode[]
): Buffer {
	const seen = new Set<string>()

	for (const node of nodes) {
		if (seen.has(node.prefix)) {
			throw new Error(
				`serializePostcodePrefixIndex: duplicate prefix "${node.prefix}" — dedupe (and SUM unitCount) before serializing`
			)
		}

		seen.add(node.prefix)

		const hasCoordinate = node.lat !== null || node.lon !== null

		if (hasCoordinate && (node.lat === null || node.lon === null)) {
			throw new Error(`serializePostcodePrefixIndex: prefix "${node.prefix}" carries half a coordinate`)
		}

		if (hasCoordinate && node.radiusP95Km === null) {
			throw new Error(
				`serializePostcodePrefixIndex: prefix "${node.prefix}" has a coordinate but no radiusP95Km — the radius is ` +
					`MANDATORY beside a coordinate, because a prefix centroid without its dispersion reads like a precise point`
			)
		}

		if (!hasCoordinate && node.radiusP95Km !== null) {
			throw new Error(
				`serializePostcodePrefixIndex: prefix "${node.prefix}" has a radiusP95Km but no coordinate — a dispersion ` +
					`with no centroid to disperse around is not a measurement`
			)
		}
	}

	const encoder = new TextEncoder()
	const frame = writeFramedHeader(MAGIC, header)

	const ancestorIndex = new Map<string, number>()
	const ancestorTable: PostcodePrefixAncestor[] = []

	const sorted = nodes.toSorted((a, b) => (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0))

	for (const node of sorted) {
		for (const ancestor of node.ancestors) {
			const key = ancestorKey(ancestor)

			if (ancestorIndex.has(key)) continue

			if (!Number.isInteger(ancestor.wofID) || Math.abs(ancestor.wofID) > MAX_EXACT_WOF_ID) {
				throw new Error(
					`serializePostcodePrefixIndex: wofID ${ancestor.wofID} ("${ancestor.name}") is not an exactly-representable integer`
				)
			}

			ancestorIndex.set(key, ancestorTable.length)
			ancestorTable.push(ancestor)
		}
	}

	const encodedAncestors = ancestorTable.map((a) => {
		const placetype = encoder.encode(a.placetype)
		const name = encoder.encode(a.name)

		if (placetype.length > MAX_U8_LEN || name.length > MAX_U8_LEN) {
			throw new Error(`serializePostcodePrefixIndex: ancestor "${a.name}" exceeds the u8 length prefix`)
		}

		return { placetype, name, wofID: a.wofID }
	})

	const encodedNodes = sorted.map((node) => {
		const prefix = encoder.encode(node.prefix)

		if (!prefix.length || prefix.length > MAX_U8_LEN) {
			throw new Error(`serializePostcodePrefixIndex: prefix "${node.prefix}" is empty or exceeds the u8 length prefix`)
		}

		if (node.ancestors.length > MAX_U8_LEN) {
			throw new Error(
				`serializePostcodePrefixIndex: prefix "${node.prefix}" has more ancestors than the u8 count holds`
			)
		}

		const refs = node.ancestors.map((a) => ancestorIndex.get(ancestorKey(a))!)

		return { node, prefix, refs }
	})

	let size = frame.length + 4

	for (const a of encodedAncestors) {
		size += 1 + a.placetype.length + 8 + 1 + a.name.length
	}

	size += 4

	for (const { node, prefix, refs } of encodedNodes) {
		size += 1 + prefix.length + 1 + refs.length * 4 + 1 + 4

		if (node.lat !== null) {
			size += 4
		}

		if (node.radiusP95Km !== null) {
			size += 4
		}
	}

	const buffer = Buffer.alloc(size)

	buffer.set(frame, 0)

	let offset = frame.length

	buffer.writeUInt32LE(encodedAncestors.length, offset)
	offset += 4

	for (const a of encodedAncestors) {
		buffer.writeUInt8(a.placetype.length, offset)
		offset += 1
		buffer.set(a.placetype, offset)
		offset += a.placetype.length
		buffer.writeDoubleLE(a.wofID, offset)
		offset += 8
		buffer.writeUInt8(a.name.length, offset)
		offset += 1
		buffer.set(a.name, offset)
		offset += a.name.length
	}

	buffer.writeUInt32LE(encodedNodes.length, offset)
	offset += 4

	for (const { node, prefix, refs } of encodedNodes) {
		buffer.writeUInt8(prefix.length, offset)
		offset += 1
		buffer.set(prefix, offset)
		offset += prefix.length

		buffer.writeUInt8(refs.length, offset)
		offset += 1

		for (const ref of refs) {
			buffer.writeUInt32LE(ref, offset)
			offset += 4
		}

		const flags = (node.lat === null ? 0 : FLAG_HAS_COORDINATE) | (node.radiusP95Km === null ? 0 : FLAG_HAS_RADIUS)

		buffer.writeUInt8(flags, offset)
		offset += 1

		if (node.lat !== null && node.lon !== null) {
			buffer.writeInt16LE(quantizeCoordinate(node.lat, LAT_Q), offset)
			offset += 2
			buffer.writeInt16LE(quantizeCoordinate(node.lon, LON_Q), offset)
			offset += 2
		}

		if (node.radiusP95Km !== null) {
			buffer.writeFloatLE(node.radiusP95Km, offset)
			offset += 4
		}

		buffer.writeUInt32LE(node.unitCount, offset)
		offset += 4
	}

	return buffer
}

/**
 * Reads PFX1 bytes into an in-memory prefix map.
 *
 * The resolver uses no Node APIs, so the browser runtime can load the same artifact.
 * Each ancestor is stored once in the file's dictionary and nodes reference it by index.
 */
export class PostcodePrefixIndexResolver {
	readonly header: PostcodePrefixHeader
	readonly #nodes: Map<string, PostcodePrefixNode>

	constructor(bytes: Uint8Array) {
		const { header, cursor } = readFramedHeader<PostcodePrefixHeader>(
			MAGIC,
			bytes,
			"PostcodePrefixIndexResolver: bad magic — not a PFX1 artifact"
		)

		this.header = header

		if (this.header.schemaVersion > KNOWN_SCHEMA_VERSION) {
			throw new Error(
				`PostcodePrefixIndexResolver: schemaVersion ${this.header.schemaVersion} is newer than this reader knows ` +
					`(known up to ${KNOWN_SCHEMA_VERSION})`
			)
		}

		if (this.header.schemaVersion !== KNOWN_SCHEMA_VERSION) {
			throw new Error(`PostcodePrefixIndexResolver: unsupported schemaVersion ${this.header.schemaVersion}`)
		}

		const decoder = new TextDecoder()
		const ancestorCount = cursor.u32()

		const ancestors: PostcodePrefixAncestor[] = []

		for (let i = 0; i < ancestorCount; i++) {
			const placetype = decoder.decode(cursor.bytes(cursor.u8()))
			const wofID = cursor.f64()
			const name = decoder.decode(cursor.bytes(cursor.u8()))

			ancestors.push({ placetype, wofID, name })
		}

		const nodeCount = cursor.u32()

		this.#nodes = new Map()

		for (let i = 0; i < nodeCount; i++) {
			const prefix = decoder.decode(cursor.bytes(cursor.u8()))
			const refCount = cursor.u8()

			const nodeAncestors: PostcodePrefixAncestor[] = []

			for (let r = 0; r < refCount; r++) {
				const idx = cursor.u32()
				const ancestor = ancestors[idx]

				if (!ancestor) {
					throw new Error(`PostcodePrefixIndexResolver: prefix "${prefix}" references ancestor ${idx}, out of range`)
				}

				nodeAncestors.push(ancestor)
			}

			const flags = cursor.u8()

			const node: PostcodePrefixNode = {
				prefix,
				ancestors: nodeAncestors,
				lat: null,
				lon: null,
				radiusP95Km: null,
				unitCount: 0,
			}

			if (flags & FLAG_HAS_COORDINATE) {
				node.lat = dequantizeCoordinate(cursor.i16(), LAT_Q)
				node.lon = dequantizeCoordinate(cursor.i16(), LON_Q)
			}

			if (flags & FLAG_HAS_RADIUS) {
				node.radiusP95Km = cursor.f32()
			}

			node.unitCount = cursor.u32()

			this.#nodes.set(prefix, node)
		}
	}

	get size(): number {
		return this.#nodes.size
	}

	/**
	 * The header's country code.
	 *
	 * A load site uses it to reject an index built for another country.
	 */
	get country(): string {
		return this.header.country
	}

	/**
	 * Iterates every node in the file's prefix-sorted order.
	 *
	 * Runtime lookups should use {@link PostcodePrefixIndexResolver.probe}.
	 */
	nodes(): IterableIterator<PostcodePrefixNode> {
		return this.#nodes.values()
	}

	/**
	 * Returns the node for one prefix, or `null` when the index has none.
	 *
	 * A miss is neutral unless the header's `coverageNote` reports that the register is complete.
	 */
	probe(prefix: string): PostcodePrefixNode | null {
		return this.#nodes.get(prefix) ?? null
	}
}
