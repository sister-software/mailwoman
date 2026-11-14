// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Binary format for the ancestrie — a materialized trie over an ancestry graph,
 *   sealed into one static artifact.
 *
 *   This module owns the layout: the header read/write pair and the section math are here
 *   so the builder (writer) and the reader can never disagree about where a table starts —
 *   the shared-function-not-shared-constants rule.
 *   All integers are little-endian, read and written through DataView
 *   so the artifact is byte-identical across platforms.
 *
 *   header (48 bytes) magic [u8. 4] "anct" version u16 1 flags u16 0 (reserved) stateCount
 *   u32 edgeCount u32 total edges across all states entryRefCount u32 total state→entry
 *   references entryCount u32 unique entries parentIDCount u32 total parent ids across
 *   all entries stringCount u32 unique tokens stringBytes u32 total UTF-8 bytes of token
 *   data (unpadded) payloadBytes u32 total payload bytes (unpadded) metadataOffset
 *   u32 byte offset of the metadata trailer (0 = none) _reserved u32
 *
 *   string table offsets [u32. stringCount + 1] byte offset into data (last = sentinel) data [u8.
 *   stringBytes] concatenated UTF-8, zero-padded to a 4-byte boundary
 *
 *   state table [stateCount × 16 bytes] edgeStart u32 index into edge table edgeCount
 *   u32 entryRefStart u32 index into entry-ref table entryRefCount u32
 *
 *   edge table [edgeCount × 8 bytes] tokenIdx u32 index into string table targetState u32.
 *   Edges within a state are sorted by token (UTF-16 code-unit order), so a walk step
 *   is a binary search and a prefix scan is a contiguous run.
 *
 *   entryref table [entryRefCount × 4 bytes] entry ordinal u32 (index into the entry table).
 *   Refs within a state are sorted rank-descending then id-ascending, so a reader's
 *   top-k at a state is its first k refs — no query-time sort.
 *
 *   entry table [entryCount × 40 bytes] id f64 pre u32 post u32 rank f32 parentStart u32 index
 *   into parent table parentCount u16 flags u16 (bit0 = has payload, bit1 = payload is JSON)
 *   payloadStart u32 byte offset into payload blob payloadLen u32, then 4 bytes of padding.
 *   Version 1 stores the id as u32 in a 32-byte record; `ancestrieLayout` holds both layouts.
 *
 *   Records are stored in PRE-order of the interval forest, so the descendants of ordinal i are
 *   exactly the ordinals i+1 .. i+(post−pre−1)/2 — descendant enumeration is a contiguous range scan.
 *
 *   PRE/post intervals: `pre` and `post` are Dietz-style pre/post-order labels drawn from
 *   a single counter over the primary-parent forest (see below), assigned at seal time.
 *   Containment is O(1) in both directions: x contains y ⟺ pre(x) ≤ pre(y)
 *   and post(y) ≤ post(x) (an entry contains itself).
 *
 *   The classic objection to interval labels — relabeling on update — is void here
 *   because the artifact is sealed and rebuilt whole, never patched.
 *
 *   DAG canonicalization: an entry may declare multiple parents.
 *   The interval forest spans the primary parent only — `parentIDs[0]` —
 *   so `contains`/`descendantsOf` answer over that single tree. the full parent
 *   list is stored in the parent table and surfaced verbatim.
 *
 *   A primary parent id that identifies no entry in the build makes its child a
 *   forest root (the declared id is still stored).
 *   A cycle in the primary-parent graph fails the seal.
 *
 *   parent table [parentIDCount × 8 bytes] f64 parent ids (u32 in version 1), concatenated per entry
 *   in entry-table order, each entry's list in the order given at build time (`parentIDs[0]` first).
 *
 *   ID index [entryCount × 16 bytes] id f64, ordinal u32, 4 bytes of padding
 *   (version 1: id u32, ordinal u32) — sorted by id ascending for binary search.
 *
 *   payload blob [payloadBytes] concatenated payload bytes in entry-table order,
 *   zero-padded to a 4-byte boundary.
 *
 *   metadata (optional trailer, at metadataOffset) jsonLen u32, then jsonLen bytes of UTF-8 JSON.
 *
 *   canonical output: the serializer is deterministic and insertion-order-independent.
 *   Strings are interned in sorted order. trie states are numbered by a pre-order DFS that
 *   visits edges in sorted-token order (root = 0); entry ordinals follow the interval
 *   forest's pre-order (roots and sibling lists sorted by id ascending).
 *
 *   The same entry set yields identical bytes after sealing, regardless of add order.
 */

/**
 * File magic, "anct" (ANCestry Trie).
 *
 * A reader rejects anything not starting with these four bytes.
 * Deliberately not "FST\0".
 *
 * This format shares ancestry with `@mailwoman/resolver-wof-sqlite`'s FST gazetteer
 * but is its own interface.
 */
export const ANCESTRIE_MAGIC: readonly number[] = [0x41, 0x4e, 0x43, 0x54]

/**
 * Format version this module writes and the newest it reads.
 *
 * Published so a freshness guard can call an older artifact format-stale without re-typing the number.
 */
export const ANCESTRIE_FORMAT_VERSION = 2

/**
 * The format version that widened every entry id and parent id from u32 to f64.
 *
 * A WOF id from the `mailwoman` fork range starts at 9,895,000,000, above the u32 maximum,
 * and `DataView.setUint32` stores such a value modulo 2^32 without an error, as a different id.
 * An f64 holds every integer up to 2^53 exactly.
 */
export const VERSION_WIDE_IDS = 2

/**
 * Where each field of an entry record sits, and how wide ids are, for one format version.
 */
export interface AncestrieLayout {
	/**
	 * 8 for f64 ids, 4 for u32 ids, in the entry, parent and id-index tables alike.
	 */
	idBytes: 4 | 8
	recordSize: number
	pre: number
	post: number
	rank: number
	parentStart: number
	parentCount: number
	flags: number
	payloadStart: number
	payloadLength: number
	/**
	 * The size of one id-index entry, and the ordinal's offset inside it.
	 */
	idIndexEntrySize: number
	idIndexOrdinal: number
}

/**
 * The record layout of format `version`.
 */
export function ancestrieLayout(version: number): AncestrieLayout {
	if (version >= VERSION_WIDE_IDS) {
		return {
			idBytes: 8,
			// 36 bytes of fields, padded to 40 so each record's f64 id starts on an 8-byte boundary.
			recordSize: 40,
			pre: 8,
			post: 12,
			rank: 16,
			parentStart: 20,
			parentCount: 24,
			flags: 26,
			payloadStart: 28,
			payloadLength: 32,
			idIndexEntrySize: 16,
			idIndexOrdinal: 8,
		}
	}

	return {
		idBytes: 4,
		recordSize: 32,
		pre: 4,
		post: 8,
		rank: 12,
		parentStart: 16,
		parentCount: 20,
		flags: 22,
		payloadStart: 24,
		payloadLength: 28,
		idIndexEntrySize: 8,
		idIndexOrdinal: 4,
	}
}

/**
 * The width of an f64 id field, the {@link VERSION_WIDE_IDS} layout's.
 */
const WIDE_ID_BYTES = 8

/**
 * The largest id a version 1 u32 id field holds.
 */
const NARROW_ID_MAX = 0xff_ff_ff_ff

/**
 * Reads an id stored at `offset` in `layout`'s width.
 */
export function readID(view: DataView, offset: number, layout: AncestrieLayout): number {
	return layout.idBytes === WIDE_ID_BYTES ? view.getFloat64(offset, true) : view.getUint32(offset, true)
}

/**
 * Writes `id` at `offset` in `layout`'s width.
 *
 * @throws When `id` isn't a safe integer, or doesn't fit a u32 layout, rather than storing another id.
 */
export function writeID(view: DataView, offset: number, id: number, layout: AncestrieLayout): void {
	const wide = layout.idBytes === WIDE_ID_BYTES

	if (!Number.isSafeInteger(id) || id < 0 || (!wide && id > NARROW_ID_MAX)) {
		throw new RangeError(`ancestrie: id ${id} does not fit a ${wide ? "64" : "32"}-bit id field`)
	}

	if (wide) {
		view.setFloat64(offset, id, true)
	} else {
		view.setUint32(offset, id, true)
	}
}

/**
 * Fixed header size in bytes: magic, version, flags plus the nine following u32 fields.
 */
const HEADER_SIZE = 48

/**
 * State-table entry: edge offset/count and entry-ref offset/count, all 32-bit.
 */
export const STATE_ENTRY_SIZE = 16

/**
 * Edge-table entry: the transition token's string index and the target state index.
 */
export const EDGE_ENTRY_SIZE = 8

/**
 * Entry-ref-table entry: one u32 ordinal into the entry table.
 */
export const ENTRY_REF_SIZE = 4

/**
 * Entry flags bit 0: this entry contains a payload.
 *
 * Presence-signaled per entry so an absent payload can never surface as an empty one —
 * the meaning-of-zero rule, in bytes.
 */
export const ENTRY_FLAG_HAS_PAYLOAD = 1

/**
 * Entry flags bit 1: the payload bytes are UTF-8 JSON and the reader parses them.
 *
 * Unset means the payload is opaque bytes handed back verbatim.
 */
export const ENTRY_FLAG_PAYLOAD_JSON = 2

/**
 * Section alignment in bytes.
 *
 * Variable-length byte sections (string data, payload blob) are padded
 * so every fixed-width table starts on a 4-byte boundary.
 */
const ALIGNMENT = 4

/**
 * Round `n` up to the next {@link alignment} boundary.
 */
function align4(n: number): number {
	return (n + ALIGNMENT - 1) & ~(ALIGNMENT - 1)
}

/**
 * The header's count fields — everything the section math needs.
 */
export interface AncestrieCounts {
	stateCount: number
	edgeCount: number
	entryRefCount: number
	entryCount: number
	parentIDCount: number
	stringCount: number
	stringBytes: number
	payloadBytes: number
}

/**
 * Absolute byte offset of each section, derived from the counts.
 *
 * `end` is the total size of the fixed layout — the metadata trailer, when present, begins there.
 */
export interface AncestrieSections {
	stringOffsets: number
	stringData: number
	stateTable: number
	edgeTable: number
	entryRefTable: number
	entryTable: number
	parentTable: number
	idIndex: number
	payloadBlob: number
	end: number
}

/**
 * Compute every section offset from the header counts and the layout of the file's version.
 *
 * The single source of section math.
 * The builder sizes and writes with it, the reader locates with it, so the two ends cannot drift.
 */
export function computeSections(counts: AncestrieCounts, layout: AncestrieLayout): AncestrieSections {
	const stringOffsets = HEADER_SIZE
	const stringData = stringOffsets + (counts.stringCount + 1) * 4
	const stateTable = stringData + align4(counts.stringBytes)
	const edgeTable = stateTable + counts.stateCount * STATE_ENTRY_SIZE
	const entryRefTable = edgeTable + counts.edgeCount * EDGE_ENTRY_SIZE
	const entryTable = entryRefTable + counts.entryRefCount * ENTRY_REF_SIZE
	const parentTable = entryTable + counts.entryCount * layout.recordSize
	const idIndex = parentTable + counts.parentIDCount * layout.idBytes
	const payloadBlob = idIndex + counts.entryCount * layout.idIndexEntrySize
	const end = payloadBlob + align4(counts.payloadBytes)

	return {
		stringOffsets,
		stringData,
		stateTable,
		edgeTable,
		entryRefTable,
		entryTable,
		parentTable,
		idIndex,
		payloadBlob,
		end,
	}
}

/**
 * The decoded header: format version, counts and metadata trailer offset (0 = none).
 */
export interface AncestrieHeader extends AncestrieCounts {
	version: number
	metadataOffset: number
}

/**
 * Write the 48-byte header.
 *
 * The field order here and in {@link readHeader} defines the format.
 * A change to either order makes the round-trip tests fail.
 */
export function writeHeader(view: DataView, header: AncestrieHeader): void {
	for (let i = 0; i < ANCESTRIE_MAGIC.length; i++) {
		view.setUint8(i, ANCESTRIE_MAGIC[i]!)
	}

	view.setUint16(4, header.version, true)
	view.setUint16(6, 0, true)
	view.setUint32(8, header.stateCount, true)
	view.setUint32(12, header.edgeCount, true)
	view.setUint32(16, header.entryRefCount, true)
	view.setUint32(20, header.entryCount, true)
	view.setUint32(24, header.parentIDCount, true)
	view.setUint32(28, header.stringCount, true)
	view.setUint32(32, header.stringBytes, true)
	view.setUint32(36, header.payloadBytes, true)
	view.setUint32(40, header.metadataOffset, true)
	view.setUint32(44, 0, true)
}

/**
 * Validate the magic and version, then decode the header.
 *
 * @throws on anything this module cannot read.
 * Never guesses at an unknown version's layout.
 */
export function readHeader(view: DataView): AncestrieHeader {
	if (view.byteLength < HEADER_SIZE) {
		throw new Error("ancestrie buffer too small for header")
	}

	for (let i = 0; i < ANCESTRIE_MAGIC.length; i++) {
		if (view.getUint8(i) !== ANCESTRIE_MAGIC[i]) {
			throw new Error("ancestrie magic mismatch")
		}
	}

	const version = view.getUint16(4, true)

	if (version < 1 || version > ANCESTRIE_FORMAT_VERSION) {
		throw new Error(`ancestrie format version ${version} unsupported (expected 1..${ANCESTRIE_FORMAT_VERSION})`)
	}

	return {
		version,
		stateCount: view.getUint32(8, true),
		edgeCount: view.getUint32(12, true),
		entryRefCount: view.getUint32(16, true),
		entryCount: view.getUint32(20, true),
		parentIDCount: view.getUint32(24, true),
		stringCount: view.getUint32(28, true),
		stringBytes: view.getUint32(32, true),
		payloadBytes: view.getUint32(36, true),
		metadataOffset: view.getUint32(40, true),
	}
}
