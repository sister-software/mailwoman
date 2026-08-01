/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   PCN1 placetype census (hierarchy-evidence campaign, R4c). Per gazetteer PARENT surface, the
 *   distribution of its children's PROJECTED `ComponentTag`s — "this parent has 33 boroughs and 642
 *   neighbourhoods, i.e. 675 dependent-locality-class children". The general form of the shipped
 *   PIX1 pair index: where PIX1 answers "is THIS child known under THIS parent?", PCN1 answers "does
 *   this parent have children of this KIND at all?" — the conditional prior that turns a globally
 *   rare tag into a conditionally common one (see plan/reference/placetype-evidence.mdx).
 *
 *   Why both artifacts exist, rather than folding the census's links into the pair index: a pair
 *   entry ASSERTS a surface is a dependent locality, so every batch of them needs a venue-confound
 *   board before it ships (the law-1 directional class — "East Acton" opening a venue name). A
 *   census node asserts nothing about any surface; it can only tilt a reading the model already
 *   entertains under a parent it already identified. That makes the census the safe way to cover
 *   the long tail the pair batches will never individually clear.
 *
 *   This file owns BOTH ends of the format — `serializePlacetypeCensus` (Node, build tooling) and
 *   `PlacetypeCensusResolver` (browser and server alike) — the same single-file discipline as
 *   `pair-index-resolver.ts` and `postcode-binary-resolver.ts`, so the layout can never drift
 *   between writer and reader.
 *
 *   Binary layout (little-endian): magic "PCN1" (4 bytes), u32 headerLen, headerLen bytes of
 *   UTF-8-encoded JSON (`PlacetypeCensusHeader`), u32 nodeCount, then nodeCount records of:
 *
 *   ```
 *   u16 parentLen, parent utf8[parentLen], u8 entryCount, entryCount × (u8 tagIdx, u32 count)
 *   ```
 *
 *   sorted by `parent` in UTF-16 code-unit order. `tagIdx` indexes `COMPONENT_TAGS` (u8, asserted at
 *   serialize time). Per-node entries are sorted by descending count, so a reader that wants only
 *   the dominant class can stop at the first entry.
 *
 *   `parent` is expected to be already folded by the caller (`normalizeFSTToken`, the same fold PIX1
 *   uses — `foldVersion` in the header records which), so one query-time fold serves both artifacts.
 */

import { COMPONENT_TAGS, type ComponentTag } from "@mailwoman/core/types"

/**
 * Tags addressable by the single-byte index the census packs.
 */
const MAX_TAGS_PER_BYTE = 256

/**
 * "PCN1" little-endian (P=0x50 C=0x43 N=0x4e 1=0x31)
 */
const MAGIC = 0x31_4e_43_50
const KNOWN_SCHEMA_VERSION = 1

/**
 * One parent node's children-tag distribution.
 */
export interface PlacetypeCensusNode {
	/**
	 * Folded parent place name (e.g. `"london"`).
	 */
	parent: string
	/**
	 * Child counts by PROJECTED tag — the placetype→`ComponentTag` projection is the BUILDER's job (see
	 * `gazetteer-pipeline/placetype-census.ts`), so this artifact never carries a placetype vocabulary of its own.
	 */
	counts: Partial<Record<ComponentTag, number>>
	/**
	 * Sum of `counts` — the node's denominator, precomputed so a consumer never has to re-sum to get a share.
	 */
	total: number
}

export interface PlacetypeCensusHeader {
	/**
	 * ISO country code this census was built for.
	 */
	country: string
	schemaVersion: 1
	/**
	 * Which fold the parent surfaces were built against — matches `PairIndexHeader.foldVersion`, so a consumer folds once
	 * and probes both artifacts.
	 */
	foldVersion: 1
	/**
	 * MD5s of the source artifact(s) this census was built from, for provenance.
	 */
	sourceMD5s: string[]
	/**
	 * ISO date the census was built.
	 */
	buildDate: string
	/**
	 * GLOBAL share of each projected tag across every counted child in the country — the denominator a consumer needs to
	 * turn a node's share into a LIFT (`nodeShare / baseRate`). Shipped in the header rather than recomputed by the
	 * consumer because the base rate is a property of the BUILD (which placetypes were counted, over which source), and a
	 * consumer re-deriving it from the node table would silently get a different number: the node table only carries
	 * parents that cleared the build's inclusion rule, so its totals are not the country's totals.
	 */
	baseRates: Partial<Record<ComponentTag, number>>
	/**
	 * OPTIONAL soft-prior bias magnitude a census hit contributes at decode time. ABSENT until a calibration task
	 * measures one — the census ships as a probeable artifact first (R4c is data + loader + offline probe, NO decode
	 * wiring), and a defaulted number here would let an uncalibrated bias reach the decoder unnoticed.
	 */
	delta?: number
}

/**
 * Serialize a placetype census to PCN1 bytes.
 *
 * Asserts its input is deduplicated by `parent` and throws otherwise — collapsing duplicate parents here would hide a
 * build bug (two extractions merged without summing their counts) behind a silently plausible artifact.
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
	const headerBytes = encoder.encode(JSON.stringify(header))

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

	let size = 4 + 4 + headerBytes.length + 4

	for (const { parent, entries } of encoded) {
		size += 2 + parent.length + 1 + entries.length * 5
	}

	const buffer = Buffer.alloc(size)
	let offset = 0

	buffer.writeUInt32LE(MAGIC, offset)
	offset += 4
	buffer.writeUInt32LE(headerBytes.length, offset)
	offset += 4
	buffer.set(headerBytes, offset)
	offset += headerBytes.length
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
 * Map-backed reader over PCN1 bytes. Pure JS, no Node imports — the browser runtime loads the same artifact.
 */
export class PlacetypeCensusResolver {
	readonly header: PlacetypeCensusHeader
	readonly #nodes: Map<string, PlacetypeCensusNode>

	constructor(bytes: Uint8Array) {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		let offset = 0

		if (view.getUint32(offset, true) !== MAGIC) {
			throw new Error("PlacetypeCensusResolver: bad magic — not a PCN1 artifact")
		}

		offset += 4

		const headerLen = view.getUint32(offset, true)
		offset += 4

		const decoder = new TextDecoder()

		this.header = JSON.parse(decoder.decode(bytes.subarray(offset, offset + headerLen))) as PlacetypeCensusHeader
		offset += headerLen

		if (this.header.schemaVersion !== KNOWN_SCHEMA_VERSION) {
			throw new Error(`PlacetypeCensusResolver: unsupported schemaVersion ${this.header.schemaVersion}`)
		}

		const nodeCount = view.getUint32(offset, true)
		offset += 4

		this.#nodes = new Map()

		for (let i = 0; i < nodeCount; i++) {
			const parentLen = view.getUint16(offset, true)
			offset += 2

			const parent = decoder.decode(bytes.subarray(offset, offset + parentLen))
			offset += parentLen

			const entryCount = view.getUint8(offset)
			offset += 1

			const counts: Partial<Record<ComponentTag, number>> = {}
			let total = 0

			for (let e = 0; e < entryCount; e++) {
				const tag = COMPONENT_TAGS[view.getUint8(offset)]
				offset += 1

				const count = view.getUint32(offset, true)
				offset += 4

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
	 * Look up one folded parent surface. Returns `null` when the parent has no census node — ABSENCE IS NOT EVIDENCE (the
	 * meaning-of-zero rule): a missing node means the gazetteer has no counted children there, which is usually coverage,
	 * so a consumer must treat `null` as neutral and never as a prohibition.
	 */
	probe(parent: string): PlacetypeCensusNode | null {
		return this.#nodes.get(parent) ?? null
	}

	/**
	 * The share of `parent`'s counted children projecting onto `tag` — `0` when the parent is unknown or the tag is
	 * unseen there. Positive evidence only: read a `0` as "no support from this artifact", never as "this tag is wrong".
	 */
	share(parent: string, tag: ComponentTag): number {
		const node = this.#nodes.get(parent)

		if (!node || !node.total) return 0

		return (node.counts[tag] ?? 0) / node.total
	}

	/**
	 * `share(parent, tag)` divided by the country's global base rate for `tag` — how much MORE likely this tag is under
	 * this parent than under a parent drawn at random. `1` means "no different from the country at large", `0` means no
	 * support. Returns `0` (not `Infinity`) when the base rate is absent, so a missing denominator can never manufacture
	 * unbounded evidence.
	 */
	lift(parent: string, tag: ComponentTag): number {
		const baseRate = this.header.baseRates[tag]

		if (!baseRate) return 0

		return this.share(parent, tag) / baseRate
	}
}
