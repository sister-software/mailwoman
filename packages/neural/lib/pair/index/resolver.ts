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
 * Sets the PIX1 schema version this reader accepts, in which each record carries
 * both the child's and the parent's `ComponentTag`.
 *
 * Older versions are refused rather than read, because their records lack the
 * parent tag byte and would decode misaligned.
 */
export const KNOWN_SCHEMA_VERSION = 3

/**
 * Describes one folded (child, parent) name pair and the component tags observed
 * at each end, as passed to {@link serializePairIndex}.
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
	 * The tag this pair resolves the parent to, which {@link serializePairIndex}
	 * requires to be a known `ComponentTag`.
	 *
	 * A builder that cannot derive it from its source's own semantics must not guess one.
	 */
	parentTag: ComponentTag
}

/**
 * Describes the typed edge a pair-index hit returns: the child's tag and the parent's tag.
 *
 * Instances are interned per resolver, so callers must not rely on identity to distinguish entries.
 */
export interface PairEdge {
	readonly tag: ComponentTag
	readonly parentTag: ComponentTag
}

/**
 * Describes the JSON header of a PIX1 pair-index file: its country, prior weights,
 * format stamps and source provenance.
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
	 * The tag names that record tag indexes point into, copied from `COMPONENT_TAGS` at serialize time.
	 *
	 * The reader throws only on a referenced name it does not know, so an index built
	 * after the tag union grows still loads if the new tag is unused.
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
	 * When absent, the prior applies no transition term rather than a default one.
	 */
	transitionBeta?: number

	/**
	 * The emission bias a hit adds to the record's `parentTag` over the parent window.
	 *
	 * When absent, the prior writes no parent bias; `PlacetypePairPriorOpts.parentDelta`
	 * overrides it at decode time.
	 */
	parentDelta?: number
}

/**
 * Describes the caller-supplied part of a {@link PairIndexHeader}, omitting `schemaVersion`
 * and `tagTable`, which {@link serializePairIndex} stamps itself.
 */
export type PairIndexHeaderInput = Omit<PairIndexHeader, "schemaVersion" | "tagTable">

function pairKey(child: string, parent: string): string {
	return `${child.length}:${child}:${parent}`
}

/**
 * Serializes a header and entries into the PIX1 binary read by {@link PairIndexResolver},
 * sorting entries by (child, parent) for deterministic output.
 *
 * @throws If `entries` contains a duplicate (child, parent) pair, if a name exceeds 65,535
 * UTF-8 bytes, or if an entry's `tag` or `parentTag` is not a known `ComponentTag`.
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
 * Reads and validates only the header of a PIX1 binary, so callers can check `country`
 * or provenance before paying for a full {@link PairIndexResolver} parse.
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
 * Reads a PIX1 pair-index binary into a map for constant-time `probe()` lookups of
 * folded (child, parent) pairs, in Node or the browser.
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
	 * Returns the typed edge a folded (child, parent) pair asserts, or `undefined`
	 * when the index has no entry for it.
	 */
	probe(childFolded: string, parentFolded: string): PairEdge | undefined {
		return this.#probeMap.get(pairKey(childFolded, parentFolded))
	}

	/**
	 * The header's child bias magnitude, exposed to satisfy {@link PairIndexLike}.
	 */
	get delta(): number {
		return this.header.delta
	}

	/**
	 * The header's ISO country code, which selects the trailing-postcode shape
	 * the prior strips from parent segments.
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
 * Describes the subset of {@link PairIndexResolver} that prior modules consume,
 * so test doubles can stand in for it.
 *
 * An absent `transitionBeta` means the index applies no transition term, not a default one.
 */
export interface PairIndexLike {
	probe(child: string, parent: string): PairEdge | undefined
	readonly delta?: number
	readonly transitionBeta?: number

	/**
	 * The parent bias magnitude, which an explicit `PlacetypePairPriorOpts.parentDelta`
	 * overrides; absent means no parent bias.
	 */
	readonly parentDelta?: number

	/**
	 * The ISO country code; absent, or a country with no known postcode shape,
	 * disables the parent-segment postcode strip.
	 */
	readonly country?: string
}
