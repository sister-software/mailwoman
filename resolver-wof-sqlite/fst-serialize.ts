/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Binary serialization for the FST gazetteer. Format:
 *
 *   HEADER (32 bytes) magic [u8; 4] "FST\0" version u16 1 flags u16 0 (reserved) stateCount u32
 *   edgeCount u32 total edges across all states placeCount u32 total place entries across all
 *   states stringCount u32 unique strings in string table stringBytes u32 total bytes of string
 *   data _reserved u32
 *
 *   STRING TABLE offsets [u32; stringCount + 1] byte offset into data (last = sentinel) data [u8;
 *   stringBytes] concatenated UTF-8
 *
 *   STATE TABLE [stateCount × 12 bytes] edgeStart u32 index into edge table placeStart u32 index into
 *   place table edgeCount u16 placeCount u16
 *
 *   EDGE TABLE [edgeCount × 8 bytes] stringIdx u32 index into string table targetState u32
 *
 *   PLACE TABLE [placeCount × 56 bytes] wofID u32 placetypeIdx u8 index into PLACETYPE_ORDER chainLen
 *   u8 0..8 _pad u16 nameIdx u32 index into string table importance f32 Wikipedia importance [0,1]
 *   (V2); was population u32 (V1) lat f32 lon f32 chain [u32; 8] parent chain (unused slots = 0)
 */

import type { FSTNode } from "./fst-matcher.ts"
import { FSTMatcher } from "./fst-matcher.ts"
import type { FSTProvenance, PlaceEntry, PlacetypeID } from "./fst-types.ts"

/**
 * Format version that widened the per-state edge and place counters from 16 to 32 bits, growing the state entry from 12
 * to 16 bytes. Readers branch on it to stay backward-compatible with v2/v3 files.
 */
const VERSION_WIDE_STATE_COUNTERS = 4

/**
 * State-table entry size in bytes at or above {@link VERSION_WIDE_STATE_COUNTERS}.
 */
const WIDE_STATE_ENTRY_SIZE = 16

/**
 * State-table entry size in bytes below {@link VERSION_WIDE_STATE_COUNTERS}.
 */
const NARROW_STATE_ENTRY_SIZE = 12

/**
 * First format version carrying the trailing metadata block; older files simply have none.
 */
const VERSION_WITH_METADATA = 3

/**
 * File magic. A reader rejects anything not starting with these four bytes before parsing further.
 */
const MAGIC = Buffer.from("FST\0", "ascii")

/**
 * Format version this serializer emits. See {@link VERSION_WIDE_STATE_COUNTERS} for what each bump changed.
 */
const VERSION = 4

/**
 * Fixed header size in bytes: magic, version, and the section offsets that follow it.
 */
const HEADER_SIZE = 32

/**
 * State-table entry: edge offset, place offset, and the two 32-bit counters (v4 widths).
 */
const STATE_ENTRY_SIZE = 16

/**
 * Edge-table entry: the transition label and the target state index.
 */
const EDGE_ENTRY_SIZE = 8

/**
 * Place-table entry: the place id, its placetype, coordinates, and importance.
 */
const PLACE_ENTRY_SIZE = 56

/**
 * Longest ancestry chain stored per place. Deeper hierarchies are truncated at the leaf end, since the specific end of
 * the chain is what disambiguates and the country end is recoverable anyway.
 */
const MAX_CHAIN_LEN = 8

/**
 * Placetypes in hierarchy order, largest first. The index into this array is what gets written into a place entry, so
 * REORDERING IT BREAKS EVERY EXISTING FILE — append instead, and bump the version.
 */
const PLACETYPE_ORDER: readonly PlacetypeID[] = [
	"country",
	"region",
	"county",
	"locality",
	"localadmin",
	"borough",
	"neighbourhood",
	"postalcode",
	"campus",
	"dependency",
	"street_affix",
]

const placetypeToIdx = new Map<string, number>()

for (let i = 0; i < PLACETYPE_ORDER.length; i++) {
	placetypeToIdx.set(PLACETYPE_ORDER[i]!, i)
}

export function serializeFST(matcher: FSTMatcher, provenance?: FSTProvenance): Buffer {
	const nodes = matcher.toNodes() as FSTNode[]

	// --- String interning ---
	const stringMap = new Map<string, number>()
	const strings: string[] = []

	function intern(s: string): number {
		let idx = stringMap.get(s)

		if (idx === undefined) {
			idx = strings.length
			strings.push(s)
			stringMap.set(s, idx)
		}

		return idx
	}

	for (const node of nodes) {
		for (const token of node.edges.keys()) {
			intern(token)
		}

		for (const place of node.places) {
			intern(place.name)
		}
	}

	const encodedStrings = strings.map((s) => Buffer.from(s, "utf8"))
	const stringBytes = encodedStrings.reduce((sum, b) => sum + b.length, 0)

	// --- Counts ---
	let totalEdges = 0
	let totalPlaces = 0

	for (const node of nodes) {
		totalEdges += node.edges.size
		totalPlaces += node.places.length
	}

	// --- Allocate ---
	const stringTableSize = (strings.length + 1) * 4 + stringBytes
	const stateTableSize = nodes.length * STATE_ENTRY_SIZE
	const edgeTableSize = totalEdges * EDGE_ENTRY_SIZE
	const placeTableSize = totalPlaces * PLACE_ENTRY_SIZE
	const provenanceJson = provenance ? Buffer.from(JSON.stringify(provenance), "utf8") : null
	const provenanceSize = provenanceJson ? 4 + provenanceJson.length : 0
	const binarySize = HEADER_SIZE + stringTableSize + stateTableSize + edgeTableSize + placeTableSize
	const totalSize = binarySize + provenanceSize
	const buf = Buffer.alloc(totalSize)
	let pos = 0

	// --- Header ---
	// flags bit0 (survey #4, 2026-07-27): place rows carry surface-ambiguity data in the former _pad
	// byte (pp+6 = crossCountryBranches u8, pp+7 reserved). Presence-signaled here so VERSION stays
	// put: pre-ambiguity artifacts read flags=0 → readers expose `undefined`, never a fake 0.
	const hasAmbiguity = nodes.some((n) => n.places.some((p) => p.crossCountryBranches !== undefined))
	MAGIC.copy(buf, pos)
	pos += 4
	buf.writeUInt16LE(VERSION, pos)
	pos += 2
	buf.writeUInt16LE(hasAmbiguity ? 1 : 0, pos)
	pos += 2
	buf.writeUInt32LE(nodes.length, pos)
	pos += 4
	buf.writeUInt32LE(totalEdges, pos)
	pos += 4
	buf.writeUInt32LE(totalPlaces, pos)
	pos += 4
	buf.writeUInt32LE(strings.length, pos)
	pos += 4
	buf.writeUInt32LE(stringBytes, pos)
	pos += 4
	buf.writeUInt32LE(provenanceJson ? binarySize : 0, pos)
	pos += 4

	// --- String table ---
	let strOffset = 0

	for (const encoded of encodedStrings) {
		buf.writeUInt32LE(strOffset, pos)
		pos += 4
		strOffset += encoded.length
	}
	buf.writeUInt32LE(strOffset, pos)
	pos += 4

	// sentinel

	for (const encoded of encodedStrings) {
		encoded.copy(buf, pos)
		pos += encoded.length
	}

	// --- State, edge, and place tables ---
	const stateTableStart = pos
	const edgeTableStart = stateTableStart + stateTableSize
	const placeTableStart = edgeTableStart + edgeTableSize

	let edgeIdx = 0
	let placeIdx = 0

	for (let si = 0; si < nodes.length; si++) {
		const node = nodes[si]!
		const sp = stateTableStart + si * STATE_ENTRY_SIZE

		buf.writeUInt32LE(edgeIdx, sp)
		buf.writeUInt32LE(placeIdx, sp + 4)
		buf.writeUInt32LE(node.edges.size, sp + 8)
		buf.writeUInt32LE(node.places.length, sp + 12)

		for (const [token, target] of node.edges) {
			const ep = edgeTableStart + edgeIdx * EDGE_ENTRY_SIZE
			buf.writeUInt32LE(intern(token), ep)
			buf.writeUInt32LE(target, ep + 4)
			edgeIdx++
		}

		for (const place of node.places) {
			const pp = placeTableStart + placeIdx * PLACE_ENTRY_SIZE
			// Filter out WOF sentinel parent IDs (negative values like -1, -4).
			const validChain = place.parentChain.filter((id) => id > 0)
			const chainLen = Math.min(validChain.length, MAX_CHAIN_LEN)
			buf.writeUInt32LE(place.wofID, pp)
			buf.writeUInt8(placetypeToIdx.get(place.placetype) ?? 0, pp + 4)
			buf.writeUInt8(chainLen, pp + 5)
			// Former _pad: byte 0 = crossCountryBranches (header flags bit0 gates the read), byte 1 reserved.
			buf.writeUInt8(hasAmbiguity ? Math.min(place.crossCountryBranches ?? 0, 255) : 0, pp + 6)
			buf.writeUInt8(0, pp + 7)
			buf.writeUInt32LE(intern(place.name), pp + 8)
			buf.writeFloatLE(place.importance, pp + 12)
			buf.writeFloatLE(place.lat, pp + 16)
			buf.writeFloatLE(place.lon, pp + 20)

			for (let ci = 0; ci < MAX_CHAIN_LEN; ci++) {
				buf.writeUInt32LE(ci < chainLen ? validChain[ci]! : 0, pp + 24 + ci * 4)
			}
			placeIdx++
		}
	}

	if (provenanceJson) {
		const trailerStart = binarySize
		buf.writeUInt32LE(provenanceJson.length, trailerStart)
		provenanceJson.copy(buf, trailerStart + 4)
	}

	return buf
}

export function deserializeFST(buf: Buffer): FSTMatcher {
	// --- Header ---
	if (buf.length < HEADER_SIZE) throw new Error("FST buffer too small for header")

	if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error("FST magic mismatch")
	const version = buf.readUInt16LE(4)

	if (version < 1 || version > VERSION) throw new Error(`FST version ${version} unsupported (expected 1..${VERSION})`)
	const isV2 = version >= 2
	// flags bit0 (survey #4): place rows carry surface-ambiguity data in the former _pad byte.
	const hasAmbiguity = (buf.readUInt16LE(6) & 1) === 1

	const stateCount = buf.readUInt32LE(8)
	const edgeCount = buf.readUInt32LE(12)
	const _placeCount = buf.readUInt32LE(16)
	const stringCount = buf.readUInt32LE(20)
	const stringBytes = buf.readUInt32LE(24)

	let pos = HEADER_SIZE

	// --- String table ---
	const strOffsets = new Uint32Array(stringCount + 1)

	for (let i = 0; i <= stringCount; i++) {
		strOffsets[i] = buf.readUInt32LE(pos)
		pos += 4
	}
	const strDataStart = pos
	const strings: string[] = new Array(stringCount)

	for (let i = 0; i < stringCount; i++) {
		const start = strDataStart + strOffsets[i]!
		const end = strDataStart + strOffsets[i + 1]!
		strings[i] = buf.toString("utf8", start, end)
	}
	pos += stringBytes

	// --- State table ---
	const stateEntrySize = version >= VERSION_WIDE_STATE_COUNTERS ? WIDE_STATE_ENTRY_SIZE : NARROW_STATE_ENTRY_SIZE
	const stateTableStart = pos
	const edgeTableStart = stateTableStart + stateCount * stateEntrySize
	const placeTableStart = edgeTableStart + edgeCount * EDGE_ENTRY_SIZE

	const nodes: FSTNode[] = new Array(stateCount)

	for (let si = 0; si < stateCount; si++) {
		const sp = stateTableStart + si * stateEntrySize
		const edgeStart = buf.readUInt32LE(sp)
		const placeStart = buf.readUInt32LE(sp + 4)
		const edgeCountForState =
			version >= VERSION_WIDE_STATE_COUNTERS ? buf.readUInt32LE(sp + 8) : buf.readUInt16LE(sp + 8)
		const placeCountForState =
			version >= VERSION_WIDE_STATE_COUNTERS ? buf.readUInt32LE(sp + 12) : buf.readUInt16LE(sp + 10)

		const edges = new Map<string, number>()

		for (let ei = 0; ei < edgeCountForState; ei++) {
			const ep = edgeTableStart + (edgeStart + ei) * EDGE_ENTRY_SIZE
			const stringIdx = buf.readUInt32LE(ep)
			const target = buf.readUInt32LE(ep + 4)
			edges.set(strings[stringIdx]!, target)
		}

		const places: PlaceEntry[] = new Array(placeCountForState)

		for (let pi = 0; pi < placeCountForState; pi++) {
			const pp = placeTableStart + (placeStart + pi) * PLACE_ENTRY_SIZE
			const chainLen = buf.readUInt8(pp + 5)
			const parentChain: number[] = []

			for (let ci = 0; ci < chainLen; ci++) {
				parentChain.push(buf.readUInt32LE(pp + 24 + ci * 4))
			}
			const rawImportance = isV2
				? buf.readFloatLE(pp + 12)
				: Math.min(1, Math.log2(1 + buf.readUInt32LE(pp + 12) / 1000) / 14)
			places[pi] = {
				wofID: buf.readUInt32LE(pp),
				placetype: PLACETYPE_ORDER[buf.readUInt8(pp + 4)] ?? "locality",
				name: strings[buf.readUInt32LE(pp + 8)]!,
				importance: rawImportance,
				lat: buf.readFloatLE(pp + 16),
				lon: buf.readFloatLE(pp + 20),
				parentChain,
				// Header flags bit0 gates the read (survey #4): pre-ambiguity artifacts expose undefined.
				...(hasAmbiguity ? { crossCountryBranches: buf.readUInt8(pp + 6) } : {}),
			}
		}

		nodes[si] = { edges, places }
	}

	return FSTMatcher.fromNodes(nodes)
}

export function readFSTProvenance(buf: Buffer): FSTProvenance | undefined {
	if (buf.length < HEADER_SIZE) return undefined

	if (!buf.subarray(0, 4).equals(MAGIC)) return undefined
	const version = buf.readUInt16LE(4)

	if (version < VERSION_WITH_METADATA) return undefined
	const provenanceOffset = buf.readUInt32LE(28)

	if (provenanceOffset === 0 || provenanceOffset >= buf.length) return undefined

	try {
		const jsonLen = buf.readUInt32LE(provenanceOffset)
		const jsonStr = buf.toString("utf8", provenanceOffset + 4, provenanceOffset + 4 + jsonLen)

		return JSON.parse(jsonStr) as FSTProvenance
	} catch {
		return undefined
	}
}
