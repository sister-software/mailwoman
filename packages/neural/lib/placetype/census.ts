/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { COMPONENT_TAGS, type ComponentTag } from "@mailwoman/codex/component"

import { readFramedHeader, writeFramedHeader } from "#binary-frame"

const MAX_TAGS_PER_BYTE = 256

const MAGIC = 0x31_4e_43_50
const KNOWN_SCHEMA_VERSION = 1

/**
 * One parent node's children-tag distribution.
 */
export interface PlacetypeCensusNode {
	/**
	 * The folded parent place name, such as `london`.
	 */
	parent: string

	/**
	 * The number of children per component tag.
	 *
	 * The builder maps placetypes to tags, so the artifact stores no placetype vocabulary.
	 */
	counts: Partial<Record<ComponentTag, number>>

	/**
	 * The sum of `counts`, which is the denominator of every share at this node.
	 */
	total: number
}

/**
 * The JSON header of a PCN1 placetype census.
 */
export interface PlacetypeCensusHeader {
	/**
	 * The ISO country code the census was built for.
	 */
	country: string
	schemaVersion: 1

	/**
	 * The fold version of the parent names.
	 *
	 * It matches `PairIndexHeader.foldVersion` so one folded string probes both artifacts.
	 */
	foldVersion: 1

	/**
	 * The MD5s of the source artifacts.
	 */
	sourceMD5s: string[]

	/**
	 * The ISO date of the build.
	 */
	buildDate: string

	/**
	 * The share of each tag across every counted child in the country,
	 * which {@link PlacetypeCensusLike.lift} divides by.
	 *
	 * The node table holds only parents that passed the inclusion rule,
	 * so summing the nodes gives a different number.
	 */
	baseRates: Partial<Record<ComponentTag, number>>

	/**
	 * The emission bias a census hit would add at decode time.
	 *
	 * It stays absent until calibration measures a value, and the decoder applies no census bias.
	 */
	delta?: number
}

/**
 * Serializes a placetype census to PCN1 bytes.
 *
 * It throws on a duplicate parent because a duplicate means the build failed to sum its counts.
 */
export function serializePlacetypeCensus(header: PlacetypeCensusHeader, nodes: readonly PlacetypeCensusNode[]): Buffer {
	if (COMPONENT_TAGS.length > MAX_TAGS_PER_BYTE) {
		throw new Error(`serializePlacetypeCensus: COMPONENT_TAGS exceeds ${MAX_TAGS_PER_BYTE}; the u8 tag index overflows`)
	}

	const seen = new Set<string>()

	for (const node of nodes) {
		if (seen.has(node.parent)) {
			throw new Error(
				`serializePlacetypeCensus: duplicate parent "${node.parent}" — dedupe (and SUM) before serializing`
			)
		}

		seen.add(node.parent)
	}

	const sorted = nodes.toSorted((a, b) => (a.parent < b.parent ? -1 : a.parent > b.parent ? 1 : 0))
	const encoder = new TextEncoder()
	const frame = writeFramedHeader(MAGIC, header)

	const encoded = sorted.map((node) => {
		const entries = Object.entries(node.counts)
			.filter((entry): entry is [ComponentTag, number] => typeof entry[1] === "number" && entry[1] > 0)
			.toSorted((a, b) => b[1] - a[1])

		if (entries.length > MAX_TAGS_PER_BYTE - 1) {
			throw new Error(
				`serializePlacetypeCensus: node "${node.parent}" has ${entries.length} tag entries; the u8 count overflows`
			)
		}

		return { parent: encoder.encode(node.parent), entries }
	})

	let size = frame.length + 4

	for (const { parent, entries } of encoded) {
		size += 2 + parent.length + 1 + entries.length * 5
	}

	const buffer = Buffer.alloc(size)

	buffer.set(frame, 0)

	let offset = frame.length

	buffer.writeUInt32LE(encoded.length, offset)
	offset += 4

	for (const { parent, entries } of encoded) {
		buffer.writeUInt16LE(parent.length, offset)
		offset += 2
		buffer.set(parent, offset)
		offset += parent.length
		buffer.writeUInt8(entries.length, offset)
		offset += 1

		for (const [tag, count] of entries) {
			const tagIdx = COMPONENT_TAGS.indexOf(tag)

			if (tagIdx === -1) {
				throw new Error(
					`serializePlacetypeCensus: unknown tag "${tag}" on parent "${Buffer.from(parent).toString("utf8")}"`
				)
			}

			buffer.writeUInt8(tagIdx, offset)
			offset += 1
			buffer.writeUInt32LE(count, offset)
			offset += 4
		}
	}

	return buffer
}

/**
 * The census lookups a consumer needs: the node for a parent and a tag's lift over the country base rate.
 *
 * The raw within-parent share is omitted because it is nearly constant for the dominant tag.
 */
export interface PlacetypeCensusLike {
	probe(parent: string): PlacetypeCensusNode | null
	lift(parent: string, tag: ComponentTag): number

	/**
	 * The ISO country code from the census header.
	 * It is optional so test doubles can omit it.
	 */
	readonly country?: string
}

/**
 * Reads PCN1 bytes into an in-memory map.
 *
 * The resolver has no Node imports, so the browser runtime can load the same artifact.
 */
export class PlacetypeCensusResolver implements PlacetypeCensusLike {
	readonly header: PlacetypeCensusHeader
	readonly #nodes: Map<string, PlacetypeCensusNode>

	constructor(bytes: Uint8Array) {
		const { header, cursor } = readFramedHeader<PlacetypeCensusHeader>(
			MAGIC,
			bytes,
			"PlacetypeCensusResolver: bad magic — not a PCN1 artifact"
		)

		this.header = header

		if (this.header.schemaVersion > KNOWN_SCHEMA_VERSION) {
			throw new Error(
				`PlacetypeCensusResolver: schemaVersion ${this.header.schemaVersion} is newer than this reader knows ` +
					`(known up to ${KNOWN_SCHEMA_VERSION})`
			)
		}

		if (this.header.schemaVersion !== KNOWN_SCHEMA_VERSION) {
			throw new Error(`PlacetypeCensusResolver: unsupported schemaVersion ${this.header.schemaVersion}`)
		}

		const decoder = new TextDecoder()
		const nodeCount = cursor.u32()

		this.#nodes = new Map()

		for (let i = 0; i < nodeCount; i++) {
			const parent = decoder.decode(cursor.bytes(cursor.u16()))
			const entryCount = cursor.u8()

			const counts: Partial<Record<ComponentTag, number>> = {}
			let total = 0

			for (let e = 0; e < entryCount; e++) {
				const tag = COMPONENT_TAGS[cursor.u8()]
				const count = cursor.u32()

				if (tag) {
					counts[tag] = count
					total += count
				}
			}

			this.#nodes.set(parent, { parent, counts, total })
		}
	}

	get size(): number {
		return this.#nodes.size
	}

	/**
	 * The ISO country code from the header.
	 */
	get country(): string {
		return this.header.country
	}

	/**
	 * Returns the census node for one folded parent name, or `null`.
	 *
	 * A `null` result usually reflects gazetteer coverage, so callers should treat it as neutral evidence.
	 */
	probe(parent: string): PlacetypeCensusNode | null {
		return this.#nodes.get(parent) ?? null
	}

	/**
	 * Returns the share of `parent`'s counted children that carry `tag`.
	 *
	 * It returns `0` when the parent is unknown or has no children with the tag.
	 * A `0` means only that this artifact offers no support.
	 */
	share(parent: string, tag: ComponentTag): number {
		const node = this.#nodes.get(parent)

		if (!node || !node.total) return 0

		return (node.counts[tag] ?? 0) / node.total
	}

	/**
	 * Returns {@link PlacetypeCensusResolver.share} divided by the country base rate for `tag`.
	 *
	 * A value of `1` matches the country as a whole.
	 * A missing base rate returns `0` to avoid dividing by zero.
	 */
	lift(parent: string, tag: ComponentTag): number {
		const baseRate = this.header.baseRates[tag]

		if (!baseRate) return 0

		return this.share(parent, tag) / baseRate
	}
}
