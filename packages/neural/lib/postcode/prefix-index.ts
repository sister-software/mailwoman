/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readFramedHeader, writeFramedHeader } from "#binary-frame"
import { dequantizeCoordinate, LAT_Q, LON_Q, quantizeCoordinate } from "#postcode/binary-resolver"

const MAGIC = 0x31_58_46_50
const KNOWN_SCHEMA_VERSION = 1

const FLAG_HAS_COORDINATE = 0b0000_0001
const FLAG_HAS_RADIUS = 0b0000_0010

const MAX_U8_LEN = 255

const MAX_EXACT_WOF_ID = Number.MAX_SAFE_INTEGER

/**
 * One admin place that a postcode prefix asserts, stored once in the file's
 * ancestor dictionary and referenced by index.
 */
export interface PostcodePrefixAncestor {
	/**
	 * The WOF placetype, such as `"country"`, `"macroregion"` or `"region"`.
	 */
	placetype: string

	/**
	 * The Who's On First id that a consumer joins against the gazetteer.
	 */
	wofID: number

	/**
	 * The display name, carried so a trace is readable without a gazetteer lookup.
	 */
	name: string
}

/**
 * One prefix and everything it asserts.
 */
export interface PostcodePrefixNode {
	/**
	 * The prefix with every non-alphanumeric character stripped and letters uppercased,
	 * such as `"941"`, `"SW1A"` or `"BT9"`.
	 */
	prefix: string

	/**
	 * The admin ancestry the prefix asserts, coarsest first.
	 *
	 * An empty list is a valid answer, as for a GB outward code in a cross-border
	 * postcode area that asserts only the country.
	 */
	ancestors: readonly PostcodePrefixAncestor[]

	/**
	 * The centroid latitude, absent together with {@link PostcodePrefixNode.lon} for an ancestry-only node.
	 */
	lat?: number
	lon?: number

	/**
	 * The measured 95th-percentile distance in km from the centroid to the units under this prefix.
	 * It is present exactly when a coordinate is present.
	 */
	radiusP95Km?: number

	/**
	 * The number of units observed under this prefix at build time, which is not a count of units that exist.
	 */
	unitCount: number
}

/**
 * The licensing tier of the index's source, as defined in `docs/engineering/reference/layer-interface.mdx`.
 *
 * It travels in the header so a share-alike (ODbL) obligation stays attached to the artifact.
 */
export type PostcodePrefixTier = "shipped" | "build-local"

/**
 * The JSON header of a PFX1 postcode-prefix index, recording its country,
 * prefix levels, source provenance, tier and attribution.
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
	 * It separates files that share a country but come from registers with different licences and coverage.
	 */
	scope: string
	schemaVersion: 1

	/**
	 * The prefix granularities in the node table, such as `["outward"]` for GB
	 * or `["3"]` for US sectional centres.
	 */
	levels: readonly string[]

	/**
	 * The numbering authority the prefixes came from, not the gazetteer they were joined to.
	 *
	 * Deriving prefixes from gazetteer parents would inherit ZIPs whose parent state
	 * is the mail processor's rather than the code's.
	 */
	source: string

	/**
	 * The MD5 checksums of the source artifacts, for provenance.
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
	 * The source licence attribution, carried so a copied artifact still names its terms.
	 */
	attribution: string

	/**
	 * States what a missing prefix means for this file.
	 *
	 * A miss in a complete register means the prefix does not exist, while a miss
	 * in a partial one may only mean it is unattested.
	 */
	coverageNote: string

	/**
	 * The soft-prior bias magnitude, absent until calibration measures one
	 * so that an uncalibrated bias cannot reach the decoder.
	 * No consumer reads it yet.
	 */
	delta?: number
}

function ancestorKey(a: PostcodePrefixAncestor): string {
	return `${a.placetype}\0${a.wofID}\0${a.name}`
}

/**
 * Serializes a postcode-prefix index to PFX1 bytes, requiring every coordinate to carry
 * `radiusP95Km` so a coarse centroid never reads as a precise point.
 *
 * @throws On a duplicate prefix, a coordinate without its radius or the reverse,
 * or a value too large for the format.
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

		const hasCoordinate = node.lat !== undefined || node.lon !== undefined

		if (hasCoordinate && (node.lat === undefined || node.lon === undefined)) {
			throw new Error(`serializePostcodePrefixIndex: prefix "${node.prefix}" carries half a coordinate`)
		}

		if (hasCoordinate && node.radiusP95Km === undefined) {
			throw new Error(
				`serializePostcodePrefixIndex: prefix "${node.prefix}" has a coordinate but no radiusP95Km — the radius is ` +
					`MANDATORY beside a coordinate, because a prefix centroid without its dispersion reads like a precise point`
			)
		}

		if (!hasCoordinate && node.radiusP95Km !== undefined) {
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

		if (node.lat !== undefined) {
			size += 4
		}

		if (node.radiusP95Km !== undefined) {
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

		const flags =
			(node.lat === undefined ? 0 : FLAG_HAS_COORDINATE) | (node.radiusP95Km === undefined ? 0 : FLAG_HAS_RADIUS)

		buffer.writeUInt8(flags, offset)
		offset += 1

		if (node.lat !== undefined && node.lon !== undefined) {
			buffer.writeInt16LE(quantizeCoordinate(node.lat, LAT_Q), offset)
			offset += 2
			buffer.writeInt16LE(quantizeCoordinate(node.lon, LON_Q), offset)
			offset += 2
		}

		if (node.radiusP95Km !== undefined) {
			buffer.writeFloatLE(node.radiusP95Km, offset)
			offset += 4
		}

		buffer.writeUInt32LE(node.unitCount, offset)
		offset += 4
	}

	return buffer
}

/**
 * The part of {@link PostcodePrefixIndexResolver} that consumers read, so `@mailwoman/resolver`
 * can use a prefix index without depending on `@mailwoman/neural`.
 */
export interface PostcodePrefixIndexLike {
	probe(prefix: string): PostcodePrefixNode | null
	readonly country?: string
}

/**
 * Reads PFX1 bytes into an in-memory prefix map, using no Node APIs
 * so the browser runtime can load the same artifact.
 */
export class PostcodePrefixIndexResolver implements PostcodePrefixIndexLike {
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

			const node: PostcodePrefixNode = { prefix, ancestors: nodeAncestors, unitCount: 0 }

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
	 * The header's country code, so a load site can reject an index built for a different locale.
	 */
	get country(): string {
		return this.header.country
	}

	/**
	 * Iterates every node in the file's prefix-sorted order; runtime lookups should
	 * use {@link PostcodePrefixIndexResolver.probe}.
	 */
	nodes(): IterableIterator<PostcodePrefixNode> {
		return this.#nodes.values()
	}

	/**
	 * Looks up one prefix, returning `null` when the index has no node for it.
	 *
	 * A miss is neutral unless the header's `coverageNote` says the register is complete.
	 */
	probe(prefix: string): PostcodePrefixNode | null {
		return this.#nodes.get(prefix) ?? null
	}
}
