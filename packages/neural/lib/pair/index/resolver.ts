/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { COMPONENT_TAGS, type ComponentTag } from "@mailwoman/codex/component"

import { type ByteCursor, readFramedHeader, writeFramedHeader } from "#binary-frame"

const MAX_TAGS_PER_BYTE = 256

const MAGIC = 0x31_58_49_50

/**
 * The PIX1 schema version this reader accepts, in which each record stores
 * both the child's and the parent's tag.
 *
 * The reader rejects older versions because their records lack the parent tag byte
 * and would decode misaligned.
 */
export const KNOWN_SCHEMA_VERSION = 3

/**
 * One folded (child, parent) name pair and the component tag of each end.
 */
export interface PairIndexEntry {
	/**
	 * The folded child place name, such as a dependent-locality or locality candidate.
	 */
	child: string

	/**
	 * The folded parent place name the child was observed under.
	 */
	parent: string

	/**
	 * The tag this pair resolves the child to.
	 */
	tag: ComponentTag

	/**
	 * The tag this pair resolves the parent to.
	 *
	 * A builder must derive it from its source data and must not substitute a default.
	 */
	parentTag: ComponentTag
}

/**
 * The child and parent tags that a pair-index hit returns.
 *
 * Each resolver shares one frozen instance among all entries with the same tags.
 */
export interface PairEdge {
	readonly tag: ComponentTag
	readonly parentTag: ComponentTag
}

/**
 * The JSON header of a PIX1 pair-index file.
 */
export interface PairIndexHeader {
	/**
	 * The ISO country code this index was built for.
	 */
	country: string

	/**
	 * The emission bias a probe hit adds to the child's tag over the child window.
	 */
	delta: number
	schemaVersion: 3

	/**
	 * The tag names that record tag indexes refer to, copied from `COMPONENT_TAGS` when serializing.
	 *
	 * The reader throws only when a record references an unknown name.
	 * An index built with newer tags still loads if no record uses them.
	 */
	tagTable: string[]

	/**
	 * The version of the name fold the entries were built against.
	 */
	foldVersion: 1

	/**
	 * MD5s of the source files, for provenance.
	 */
	sourceMD5s: string[]

	/**
	 * The ISO date the index was built.
	 */
	buildDate: string

	/**
	 * The decoder bonus a hit adds to the transition into `B-<tag>` at the child window's first piece.
	 *
	 * When absent, the prior applies no transition bonus.
	 */
	transitionBeta?: number

	/**
	 * The emission bias a hit adds to the record's `parentTag` over the parent window.
	 *
	 * When absent, the prior adds no parent bias.
	 * `PlacetypePairPriorOpts.parentDelta` overrides it at decode time.
	 */
	parentDelta?: number
}

/**
 * The caller-supplied part of a {@link PairIndexHeader}. {@link serializePairIndex}
 * fills in `schemaVersion` and `tagTable`.
 */
export type PairIndexHeaderInput = Omit<PairIndexHeader, "schemaVersion" | "tagTable">

function pairKey(child: string, parent: string): string {
	return `${child.length}:${child}:${parent}`
}

/**
 * Serializes a header and entries into the PIX1 binary that {@link PairIndexResolver} reads.
 *
 * Entries are sorted by (child, parent) so the output is deterministic.
 *
 * @throws If `entries` contains a duplicate (child, parent) pair, if a name exceeds
 * 65,535 UTF-8 bytes, or if a tag is unknown.
 */
export function serializePairIndex(header: PairIndexHeaderInput, entries: readonly PairIndexEntry[]): Uint8Array {
	if (COMPONENT_TAGS.length > MAX_TAGS_PER_BYTE) {
		throw new Error(
			`pair index: COMPONENT_TAGS has ${COMPONENT_TAGS.length} tags, which exceeds the u8 tagIdx cap (256)`
		)
	}

	const fullHeader: PairIndexHeader = { ...header, schemaVersion: KNOWN_SCHEMA_VERSION, tagTable: [...COMPONENT_TAGS] }

	const tagIndex = new Map<ComponentTag, number>(COMPONENT_TAGS.map((tag, i) => [tag, i]))

	// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array. toSorted would double-allocate on a hot path
	const sorted = [...entries].sort((a, b) =>
		a.child < b.child ? -1 : a.child > b.child ? 1 : a.parent < b.parent ? -1 : a.parent > b.parent ? 1 : 0
	)

	for (let i = 1; i < sorted.length; i++) {
		const prev = sorted[i - 1]!
		const cur = sorted[i]!

		if (cur.child === prev.child && cur.parent === prev.parent) {
			throw new Error(`pair index: duplicate (child, parent) pair "${cur.child}" / "${cur.parent}" — dedupe upstream`)
		}
	}

	const encoder = new TextEncoder()

	const encodedPairs = sorted.map((e) => {
		const child = encoder.encode(e.child)
		const parent = encoder.encode(e.parent)

		if (child.length > 0xff_ff || parent.length > 0xff_ff) {
			throw new Error(`pair index: "${e.child}" / "${e.parent}" exceeds the u16 length prefix`)
		}

		const tagIdx = tagIndex.get(e.tag)

		if (tagIdx === undefined) {
			throw new Error(`pair index: unrecognized ComponentTag "${e.tag}"`)
		}

		const parentTagIdx = tagIndex.get(e.parentTag)

		if (parentTagIdx === undefined) {
			throw new Error(
				`pair index: entry "${e.child}" / "${e.parent}" has an unrecognized parentTag "${e.parentTag}" — ` +
					`every schema-3 record states BOTH ends of the edge; the builder must read the parent's tag from its ` +
					`source's own semantics rather than defaulting one`
			)
		}

		return { child, parent, tagIdx, parentTagIdx }
	})

	const frame = writeFramedHeader(MAGIC, fullHeader)

	let size = frame.length + 4

	for (const p of encodedPairs) {
		size += 2 + p.child.length + 2 + p.parent.length + 1 + 1
	}

	const buf = new Uint8Array(size)
	const view = new DataView(buf.buffer)

	buf.set(frame, 0)

	let o = frame.length
	view.setUint32(o, encodedPairs.length, true)
	o += 4

	for (const p of encodedPairs) {
		view.setUint16(o, p.child.length, true)
		o += 2
		buf.set(p.child, o)
		o += p.child.length
		view.setUint16(o, p.parent.length, true)
		o += 2
		buf.set(p.parent, o)
		o += p.parent.length
		buf[o++] = p.tagIdx
		buf[o++] = p.parentTagIdx
	}

	return buf
}

/**
 * Reads and validates only the header of a PIX1 binary.
 *
 * Callers use it to check `country` or provenance before a full {@link PairIndexResolver} parse.
 */
export function peekPairIndexHeader(bytes: Uint8Array): PairIndexHeader {
	return readHeaderBlock(bytes).header
}

function readHeaderBlock(bytes: Uint8Array): { header: PairIndexHeader; cursor: ByteCursor } {
	const { header, cursor } = readFramedHeader<PairIndexHeader>(MAGIC, bytes, "pair index: bad magic")

	if (header.schemaVersion < KNOWN_SCHEMA_VERSION) {
		throw new Error(
			`pair index: schemaVersion ${header.schemaVersion} predates the typed parent record (v3, 2026-08-04) — ` +
				`rebuild the artifact via \`mailwoman gazetteer pair-index\``
		)
	}

	if (header.schemaVersion > KNOWN_SCHEMA_VERSION) {
		throw new Error(
			`pair index: schemaVersion ${header.schemaVersion} is newer than this reader knows (known up to ${KNOWN_SCHEMA_VERSION})`
		)
	}

	return { header, cursor }
}

/**
 * Loads a PIX1 pair-index binary into a map for constant-time `probe()` lookups
 * of folded (child, parent) pairs.
 *
 * It runs in Node and in the browser.
 */
export class PairIndexResolver {
	readonly header: PairIndexHeader
	readonly #probeMap: ReadonlyMap<string, PairEdge>

	constructor(bytes: Uint8Array) {
		const { header, cursor } = readHeaderBlock(bytes)

		this.header = header

		const pairCount = cursor.u32()
		const decoder = new TextDecoder()
		const map = new Map<string, PairEdge>()

		const knownTags = new Set<string>(COMPONENT_TAGS)

		const edges = new Map<string, PairEdge>()

		const resolveTag = (idx: number, field: "tagIdx" | "parentTagIdx"): ComponentTag => {
			const name = header.tagTable[idx]

			if (name === undefined) {
				throw new Error(`pair index: ${field} ${idx} is outside the header's tagTable (${header.tagTable.length})`)
			}

			if (!knownTags.has(name)) {
				throw new Error(`pair index: tagTable entry "${name}" is not a ComponentTag this reader knows`)
			}

			return name as ComponentTag
		}

		for (let i = 0; i < pairCount; i++) {
			const child = decoder.decode(cursor.bytes(cursor.u16()))
			const parent = decoder.decode(cursor.bytes(cursor.u16()))
			const tagIdx = cursor.u8()
			const parentTagIdx = cursor.u8()
			const edgeKey = `${tagIdx}:${parentTagIdx}`

			let edge = edges.get(edgeKey)

			if (!edge) {
				edge = Object.freeze({
					tag: resolveTag(tagIdx, "tagIdx"),
					parentTag: resolveTag(parentTagIdx, "parentTagIdx"),
				})

				edges.set(edgeKey, edge)
			}

			map.set(pairKey(child, parent), edge)
		}

		this.#probeMap = map
	}

	/**
	 * Returns the edge for a folded (child, parent) pair, or `undefined` when the index has no entry for it.
	 */
	probe(childFolded: string, parentFolded: string): PairEdge | undefined {
		return this.#probeMap.get(pairKey(childFolded, parentFolded))
	}

	/**
	 * The header's child bias magnitude.
	 */
	get delta(): number {
		return this.header.delta
	}

	/**
	 * The header's ISO country code, which selects the postcode pattern the prior strips from parent segments.
	 */
	get country(): string {
		return this.header.country
	}

	/**
	 * The header's transition bonus, or `undefined` when the index applies no transition term.
	 */
	get transitionBeta(): number | undefined {
		return this.header.transitionBeta
	}

	/**
	 * The header's parent bias magnitude, or `undefined` when the index applies no parent bias.
	 */
	get parentDelta(): number | undefined {
		return this.header.parentDelta
	}
}

/**
 * The subset of {@link PairIndexResolver} that the priors use, which test doubles can implement.
 *
 * An absent `transitionBeta` means the index applies no transition bonus.
 */
export interface PairIndexLike {
	probe(child: string, parent: string): PairEdge | undefined
	readonly delta?: number
	readonly transitionBeta?: number

	/**
	 * The parent bias magnitude.
	 *
	 * An absent value means no parent bias, and `PlacetypePairPriorOpts.parentDelta` overrides it.
	 */
	readonly parentDelta?: number

	/**
	 * The ISO country code.
	 *
	 * Without it, or without a known postcode pattern for it, the prior does not
	 * strip postcodes from parent segments.
	 */
	readonly country?: string
}
