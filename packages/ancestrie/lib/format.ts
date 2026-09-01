/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Binary format for the ancestrie — a materialized trie over an ancestry graph, sealed into one
 *   static artifact. This module owns the layout: the header read/write pair and the section math
 *   are HERE so the builder (writer) and the reader can never disagree about where a table starts —
 *   the shared-function-not-shared-constants rule. All integers are little-endian, read and written
 *   through DataView so the artifact is byte-identical across platforms.
 *
 *   HEADER (48 bytes) magic [u8; 4] "ANCT" version u16 1 flags u16 0 (reserved) stateCount u32
 *   edgeCount u32 total edges across all states entryRefCount u32 total state→entry references
 *   entryCount u32 unique entries parentIDCount u32 total parent ids across all entries stringCount
 *   u32 unique tokens stringBytes u32 total UTF-8 bytes of token data (unpadded) payloadBytes u32
 *   total payload bytes (unpadded) metadataOffset u32 byte offset of the metadata trailer (0 = none)
 *   _reserved u32
 *
 *   STRING TABLE offsets [u32; stringCount + 1] byte offset into data (last = sentinel) data [u8;
 *   stringBytes] concatenated UTF-8, zero-padded to a 4-byte boundary
 *
 *   STATE TABLE [stateCount × 16 bytes] edgeStart u32 index into edge table edgeCount u32
 *   entryRefStart u32 index into entry-ref table entryRefCount u32
 *
 *   EDGE TABLE [edgeCount × 8 bytes] tokenIdx u32 index into string table targetState u32. Edges
 *   within a state are sorted by token (UTF-16 code-unit order), so a walk step is a binary search
 *   and a prefix scan is a contiguous run.
 *
 *   ENTRYREF TABLE [entryRefCount × 4 bytes] entry ordinal u32 (index into the entry table). Refs
 *   within a state are sorted rank-descending then id-ascending, so a reader's top-k at a state is
 *   its first k refs — no query-time sort.
 *
 *   ENTRY TABLE [entryCount × 32 bytes] id u32 pre u32 post u32 rank f32 parentStart u32 index into
 *   parent table parentCount u16 flags u16 (bit0 = has payload, bit1 = payload is JSON)
 *   payloadStart u32 byte offset into payload blob payloadLen u32. Records are stored in PRE-ORDER
 *   of the interval forest, so the descendants of ordinal i are exactly the ordinals i+1 ..
 *   i+(post−pre−1)/2 — descendant enumeration is a contiguous range scan.
 *
 *   PRE/POST INTERVALS: `pre` and `post` are Dietz-style pre/post-order labels drawn from a single
 *   counter over the PRIMARY-parent forest (see below), assigned at seal time. Containment is O(1)
 *   in both directions: x contains y ⟺ pre(x) ≤ pre(y) AND post(y) ≤ post(x) (an entry contains
 *   itself). The classic objection to interval labels — relabeling on update — is void here because
 *   the artifact is sealed and rebuilt whole, never patched.
 *
 *   DAG CANONICALIZATION: an entry may declare multiple parents. The interval forest spans the
 *   PRIMARY parent only — `parentIDs[0]` — so `contains`/`descendantsOf` answer over that single
 *   tree; the full parent list is stored in the parent table and surfaced verbatim. A primary
 *   parent id that names no entry in the build makes its child a forest root (the declared id is
 *   still stored). A cycle in the primary-parent graph fails the seal.
 *
 *   PARENT TABLE [parentIDCount × 4 bytes] u32 parent ids, concatenated per entry in entry-table
 *   order, each entry's list in the order given at build time (`parentIDs[0]` first).
 *
 *   ID INDEX [entryCount × 8 bytes] id u32, ordinal u32 — sorted by id ascending for binary search.
 *
 *   PAYLOAD BLOB [payloadBytes] concatenated payload bytes in entry-table order, zero-padded to a
 *   4-byte boundary.
 *
 *   METADATA (optional trailer, at metadataOffset) jsonLen u32, then jsonLen bytes of UTF-8 JSON.
 *
 *   CANONICAL OUTPUT: the serializer is deterministic AND insertion-order-independent. Strings are
 *   interned in sorted order; trie states are numbered by a pre-order DFS that visits edges in
 *   sorted-token order (root = 0); entry ordinals follow the interval forest's pre-order (roots and
 *   sibling lists sorted by id ascending). Sealing the same entry set twice — in any add order —
 *   yields identical bytes.
 */

/**
 * File magic, "ANCT" (ANCestry Trie). A reader rejects anything not starting with these four bytes. Deliberately NOT
 * "FST\0" — this format shares ancestry with `@mailwoman/resolver-wof-sqlite`'s FST gazetteer but is its own contract.
 */
export const ANCESTRIE_MAGIC: readonly number[] = [0x41, 0x4e, 0x43, 0x54]

/**
 * Format version this module writes and the newest it reads. Published so a freshness guard can call an older artifact
 * format-stale without re-typing the number.
 */
export const ANCESTRIE_FORMAT_VERSION = 1

/**
 * Fixed header size in bytes: magic, version, flags, and the nine u32 fields that follow.
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
 * Entry-table record: id, pre/post interval labels, rank, parent-list slice, flags, payload slice.
 */
export const ENTRY_RECORD_SIZE = 32

/**
 * ID-index entry: (id, ordinal) pair for binary search.
 */
export const ID_INDEX_ENTRY_SIZE = 8

/**
 * Entry flags bit 0: this entry carries a payload. Presence-signaled per entry so an absent payload can never surface
 * as an empty one — the meaning-of-zero rule, in bytes.
 */
export const ENTRY_FLAG_HAS_PAYLOAD = 1

/**
 * Entry flags bit 1: the payload bytes are UTF-8 JSON and the reader parses them; unset means the payload is opaque
 * bytes handed back verbatim.
 */
export const ENTRY_FLAG_PAYLOAD_JSON = 2

/**
 * Section alignment in bytes. Variable-length byte sections (string data, payload blob) are padded so every fixed-width
 * table starts on a 4-byte boundary.
 */
const ALIGNMENT = 4

/**
 * Round `n` up to the next {@link ALIGNMENT} boundary.
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
 * Absolute byte offset of each section, derived from the counts. `end` is the total size of the fixed layout — the
 * metadata trailer, when present, begins there.
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
 * Compute every section offset from the header counts. The single source of section math — the builder sizes and writes
 * with it, the reader locates with it, so the two ends cannot drift.
 */
export function computeSections(counts: AncestrieCounts): AncestrieSections {
	const stringOffsets = HEADER_SIZE
	const stringData = stringOffsets + (counts.stringCount + 1) * 4
	const stateTable = stringData + align4(counts.stringBytes)
	const edgeTable = stateTable + counts.stateCount * STATE_ENTRY_SIZE
	const entryRefTable = edgeTable + counts.edgeCount * EDGE_ENTRY_SIZE
	const entryTable = entryRefTable + counts.entryRefCount * ENTRY_REF_SIZE
	const parentTable = entryTable + counts.entryCount * ENTRY_RECORD_SIZE
	const idIndex = parentTable + counts.parentIDCount * 4
	const payloadBlob = idIndex + counts.entryCount * ID_INDEX_ENTRY_SIZE
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
 * The decoded header: format version, counts, and the metadata trailer offset (0 = none).
 */
export interface AncestrieHeader extends AncestrieCounts {
	version: number
	metadataOffset: number
}

/**
 * Write the 48-byte header. The field order here and in {@link readHeader} IS the format — change one and the round-trip
 * tests fail, which is the point.
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
 * Validate the magic and version, then decode the header. Throws on anything this module cannot read; never guesses at
 * an unknown version's layout.
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
