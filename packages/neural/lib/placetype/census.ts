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
	 * Gives the folded parent place name, such as `london`.
	 */
	parent: string

	/**
	 * Counts children per component tag; the builder projects placetypes onto tags,
	 * so the artifact carries no placetype vocabulary.
	 */
	counts: Partial<Record<ComponentTag, number>>

	/**
	 * Sums `counts` to give the denominator of every share at this node.
	 */
	total: number
}

/**
 * Holds the JSON header of a PCN1 placetype census, including the per-tag country
 * base rates that {@link PlacetypeCensusLike.lift} divides by.
 */
export interface PlacetypeCensusHeader {
	/**
	 * Gives the ISO country code the census was built for.
	 */
	country: string
	schemaVersion: 1

	/**
	 * Gives the fold version of the parent surfaces, which matches `PairIndexHeader.foldVersion`
	 * so one folded string probes both artifacts.
	 */
	foldVersion: 1

	/**
	 * Lists the MD5s of the source artifacts the census was built from.
	 */
	sourceMD5s: string[]

	/**
	 * Gives the ISO date of the build.
	 */
	buildDate: string

	/**
	 * Gives the share of each tag across every counted child in the country,
	 * which {@link PlacetypeCensusLike.lift} divides by.
	 *
	 * The build records it because the node table holds only parents that passed the
	 * inclusion rule, so re-summing the nodes gives a different number.
	 */
	baseRates: Partial<Record<ComponentTag, number>>

	/**
	 * Sets the soft-prior bias a census hit would contribute at decode time.
	 *
	 * It stays absent until calibration measures one, so no uncalibrated bias can reach the decoder.
	 */
	delta?: number
}

/**
 * Serializes a placetype census to PCN1 bytes.
 *
 * It throws on duplicate parents rather than merging them, because a duplicate
 * signals a build that failed to sum its counts.
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
 * Describes the census reads a consumer needs: whether a parent is known,
 * and a tag's lift over the country base rate.
 *
 * It omits raw within-parent share, which is nearly constant for the dominant class
 * and so carries little signal.
 */
export interface PlacetypeCensusLike {
	probe(parent: string): PlacetypeCensusNode | null
	lift(parent: string, tag: ComponentTag): number

	/**
	 * Gives the ISO country code from the census header, and is optional
	 * so a hand-built test double can omit it.
	 */
	readonly country?: string
}

/**
 * Reads PCN1 bytes into an in-memory map, without Node imports so that the
 * browser runtime can load the same artifact.
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
	 * Gives the ISO country code from the header, which the loader checks
	 * so that a census built for another country is refused.
	 */
	get country(): string {
		return this.header.country
	}

	/**
	 * Looks up the census node for one folded parent surface.
	 *
	 * A `null` result usually reflects gazetteer coverage rather than an impossible
	 * parent, so treat it as neutral evidence.
	 */
	probe(parent: string): PlacetypeCensusNode | null {
		return this.#nodes.get(parent) ?? null
	}

	/**
	 * Returns the share of `parent`'s counted children that carry `tag`, or `0`
	 * when the parent is unknown or the tag is unseen there.
	 *
	 * A `0` means this artifact offers no support, not that the tag is wrong.
	 */
	share(parent: string, tag: ComponentTag): number {
		const node = this.#nodes.get(parent)

		if (!node || !node.total) return 0

		return (node.counts[tag] ?? 0) / node.total
	}

	/**
	 * Returns {@link PlacetypeCensusResolver.share} divided by the country base rate for `tag`,
	 * so `1` means no different from the country at large and `0` means no support.
	 * A missing base rate returns `0` rather than `Infinity`.
	 */
	lift(parent: string, tag: ComponentTag): number {
		const baseRate = this.header.baseRates[tag]

		if (!baseRate) return 0

		return this.share(parent, tag) / baseRate
	}
}
