/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   PIX1 placetype-pair index (placetype-pair-prior arc, Task 2). A pure-JS, browser-safe lookup
 *   from a folded (child, parent) place-name pair to the `ComponentTag` the pair resolves to (e.g.
 *   "shoreditch" under "london" → `dependent_locality`) — the retrieval-augmented complement to the
 *   encoder's own judgment, following the same PCB1 single-file writer+reader pattern as
 *   `postcode-binary-resolver.ts` so the layout can never drift between the two ends.
 *
 *   This file owns BOTH ends of the format — `serializePairIndex` (run in Node by the shard-build
 *   tooling) and `PairIndexResolver` (run in the browser and server alike) — with zero Node imports
 *   in the reader path.
 *
 *   Binary layout (little-endian): magic "PIX1" (4 bytes) u32 headerLen, headerLen bytes of
 *   UTF-8-encoded JSON (`PairIndexHeader`) u32 pairCount, then pairCount records of:
 *
 *   ```
 *   u16 childLen, child utf8[childLen], u16 parentLen, parent utf8[parentLen], u8 tagIdx
 *   ```
 *
 *   sorted by (child, parent) UTF-16 code-unit order. `tagIdx` indexes `COMPONENT_TAGS` (u8 caps at
 *   256 tags; asserted at serialize time — the table is nowhere near that today).
 *
 *   This departs from PCB1's fixed-width key table on purpose: postcodes are bounded (~7 ASCII
 *   chars), but place names vary widely in byte length, so a fixed-width key would either truncate
 *   long names or waste space padding short ones. A `u16`-length-prefixed UTF-8 string per field
 *   costs 2 extra bytes per pair — irrelevant at the ~20k-entry scale this index targets — in
 *   exchange for exact byte-for-byte names. `probe()` is Map-backed (built once in the constructor)
 *   rather than binary search, for the same reason: variable-width records make positional
 *   `record[i]` addressing awkward, and 20k entries is small enough that the Map's O(n) build cost
 *   and memory footprint are non-issues.
 *
 *   `child`/`parent` are expected to already be folded (NFKC-lowered, punctuation-stripped — see
 *   `normalizeFSTToken` in `fst-prior.ts`) by the caller; `foldVersion` in the header records which
 *   fold the entries were built against, so a consumer can detect a stale index if the fold changes.
 *
 *   Duplicate-tolerance is explicitly NOT a serializer concern: `serializePairIndex` asserts its
 *   input is already deduped by (child, parent) and throws otherwise. Building the shard is where
 *   duplicates should be resolved (e.g. picking the higher-confidence tag) — silently last-write-wins
 *   or first-write-wins at serialize time would hide a shard-build bug.
 */

import { COMPONENT_TAGS, type ComponentTag } from "@mailwoman/core/types"

const MAGIC = 0x31_58_49_50 // "PIX1" little-endian (P=0x50 I=0x49 X=0x58 1=0x31)
const KNOWN_SCHEMA_VERSION = 1

export interface PairIndexEntry {
	/** Folded child place name (e.g. a dependent_locality or locality candidate). */
	child: string
	/** Folded parent place name the child was observed under. */
	parent: string
	/** The `ComponentTag` this (child, parent) pair resolves to. */
	tag: ComponentTag
}

export interface PairIndexHeader {
	/** ISO country code this shard was built for. */
	country: string
	/** The soft-prior bias magnitude a probe hit should contribute (consumer-interpreted). */
	delta: number
	schemaVersion: 1
	/** Which fold (`normalizeFSTToken`-style normalization) the entries were built against. */
	foldVersion: 1
	/** MD5s of the source file(s) this shard was built from, for provenance. */
	sourceMD5s: string[]
	/** ISO date the shard was built. */
	buildDate: string
}

/**
 * Join a (child, parent) pair into a single unambiguous Map key. Folded place names can contain spaces (the fold leaves
 * Zs-category whitespace intact -- see normalizeFSTToken in fst-prior.ts), so a plain space delimiter would collide
 * ("new york" + "ny" vs "new" + "york ny" both naively join to "new york ny"). Prefixing with child's UTF-16 length
 * pins the exact split point regardless of what characters either string contains.
 */
function pairKey(child: string, parent: string): string {
	return `${child.length}:${child}:${parent}`
}

/**
 * Serialize (header, entries) into the PIX1 flat binary. Entries are sorted by (child, parent) so the format is
 * deterministic regardless of input order. Run in Node; consumed by {@link PairIndexResolver}.
 *
 * Throws if `entries` contains a duplicate (child, parent) pair (dedupe upstream — see the file-header note on why this
 * isn't silently resolved here), or if a child/parent string exceeds the u16 length prefix (65,535 UTF-8 bytes — no
 * real place name approaches this).
 */
export function serializePairIndex(header: PairIndexHeader, entries: readonly PairIndexEntry[]): Uint8Array {
	if (COMPONENT_TAGS.length > 256) {
		throw new Error(
			`pair index: COMPONENT_TAGS has ${COMPONENT_TAGS.length} tags, which exceeds the u8 tagIdx cap (256)`
		)
	}

	const tagIndex = new Map<ComponentTag, number>(COMPONENT_TAGS.map((tag, i) => [tag, i]))
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

		return { child, parent, tagIdx }
	})

	const headerBytes = encoder.encode(JSON.stringify(header))

	let size = 4 /* magic */ + 4 /* headerLen */ + headerBytes.length + 4 /* pairCount */

	for (const p of encodedPairs) {
		size += 2 + p.child.length + 2 + p.parent.length + 1
	}

	const buf = new Uint8Array(size)
	const view = new DataView(buf.buffer)

	let o = 0
	view.setUint32(o, MAGIC, true)
	o += 4
	view.setUint32(o, headerBytes.length, true)
	o += 4
	buf.set(headerBytes, o)
	o += headerBytes.length
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
	}

	return buf
}

/**
 * Read just the magic + header block (no entry parsing, no Map build) — the same validation the constructor does
 * (bad-magic throw, future-schema throw) but stops the instant the header JSON is decoded. Lets a caller inspect
 * `country`/`delta`/`sourceMD5s` etc. before paying for the full entry parse — e.g.
 * `NeuralAddressClassifier.loadFromWeights`'s hard country gate (`classifier.ts`) reads this FIRST and only constructs
 * a `PairIndexResolver` (which walks every entry to build the probe `Map`) when the header's country matches the
 * resolved locale; a mismatch skips construction entirely rather than paying the full parse just to discard the
 * result.
 */
export function peekPairIndexHeader(bytes: Uint8Array): PairIndexHeader {
	return readHeaderBlock(bytes).header
}

/**
 * Shared magic+header decode used by both {@link peekPairIndexHeader} and the {@link PairIndexResolver} constructor, so
 * the two can never drift on what counts as a valid header. Returns the parsed header AND the byte offset immediately
 * following it, so the constructor can resume entry parsing from exactly where this left off without re-decoding.
 */
function readHeaderBlock(bytes: Uint8Array): { header: PairIndexHeader; offset: number } {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

	if (view.getUint32(0, true) !== MAGIC) throw new Error("pair index: bad magic")

	let o = 4
	const headerLen = view.getUint32(o, true)
	o += 4
	const decoder = new TextDecoder()
	const header = JSON.parse(decoder.decode(bytes.subarray(o, o + headerLen))) as PairIndexHeader
	o += headerLen

	if (header.schemaVersion > KNOWN_SCHEMA_VERSION) {
		throw new Error(
			`pair index: schemaVersion ${header.schemaVersion} is newer than this reader knows (known up to ${KNOWN_SCHEMA_VERSION})`
		)
	}

	return { header, offset: o }
}

/**
 * Pure-JS, browser-safe reader over the PIX1 flat binary. Builds a `Map<pairKey, ComponentTag>` once in the constructor
 * (cheap at the ~20k-entry scale this index targets) so `probe()` is O(1).
 */
export class PairIndexResolver {
	readonly header: PairIndexHeader
	readonly #probeMap: ReadonlyMap<string, ComponentTag>

	constructor(bytes: Uint8Array) {
		const { header, offset } = readHeaderBlock(bytes)

		this.header = header

		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		let o = offset
		const pairCount = view.getUint32(o, true)
		o += 4

		const decoder = new TextDecoder()
		const map = new Map<string, ComponentTag>()

		for (let i = 0; i < pairCount; i++) {
			const childLen = view.getUint16(o, true)
			o += 2
			const child = decoder.decode(bytes.subarray(o, o + childLen))
			o += childLen
			const parentLen = view.getUint16(o, true)
			o += 2
			const parent = decoder.decode(bytes.subarray(o, o + parentLen))
			o += parentLen
			const tagIdx = bytes[o++]!

			map.set(pairKey(child, parent), COMPONENT_TAGS[tagIdx]!)
		}

		this.#probeMap = map
	}

	/** Look up the `ComponentTag` for a folded (child, parent) pair, or `undefined` if the index has no entry for it. */
	probe(childFolded: string, parentFolded: string): ComponentTag | undefined {
		return this.#probeMap.get(pairKey(childFolded, parentFolded))
	}

	/**
	 * Exposes the calibrated delta bias magnitude so the resolver conforms to {@link PairIndexLike} and can be passed
	 * directly.
	 */
	get delta(): number {
		return this.header.delta
	}
}

/**
 * Minimal subset of `PairIndexResolver` a prior module consumes — structural typing so callers depend on the shape, not
 * the class (the `query-shape-prior.ts` "…Like" convention). `delta` is optional because a hand-built test double may
 * omit it; a real index's header carries the authoritative value.
 */
export interface PairIndexLike {
	probe(child: string, parent: string): ComponentTag | undefined
	readonly delta?: number
}
