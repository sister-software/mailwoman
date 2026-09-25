/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Binary serialization for the FST gazetteer.
 *
 *   All integers are little-endian. The writer emits the current version, and the reader accepts every earlier one.
 *
 *   - Header, 32 bytes: magic `FST\0`, version u16, flags u16 (bit 0 means `crossCountryBranches` is present),
 *     stateCount u32, edgeCount u32, placeCount u32, stringCount u32, stringBytes u32, and the provenance offset u32
 *     (0 when absent).
 *   - String table: `stringCount + 1` u32 offsets, the last being a sentinel, followed by the UTF-8 data.
 *   - State table, 16 bytes per state: edgeStart u32, placeStart u32, edgeCount u32, placeCount u32. Before version
 *     4 the entry is 12 bytes with u16 counts.
 *   - Edge table, 8 bytes per edge: stringIdx u32, targetState u32.
 *   - Place table, 60 bytes per place: wofID u32, placetypeIdx u8, chainLen u8, crossCountryBranches u8,
 *     placeFlags u8 (bit 0 means `encyclopedic` is present), nameIdx u32, referential f32, lat f32, lon f32, eight
 *     u32 parent ids, and encyclopedic f32. Before version 5 the entry is 56 bytes without the encyclopedic score.
 *   - Provenance trailer: a u32 length followed by JSON.
 *
 *   Presence bits keep a missing value distinct from a stored zero.
 */

import { tryParsingJSON, stringifyJSON } from "@mailwoman/core/json"

import {
	EDGE_ENTRY_SIZE,
	ENCYCLOPEDIC_OFFSET,
	FST_FORMAT_VERSION,
	FST_MAGIC_BYTES,
	HEADER_SIZE,
	LEGACY_PLACE_ENTRY_SIZE,
	NARROW_STATE_ENTRY_SIZE,
	PLACE_FLAG_HAS_ENCYCLOPEDIC,
	PLACETYPE_ORDER,
	SPLIT_PLACE_ENTRY_SIZE,
	VERSION_TWO_SCORE_SPLIT,
	VERSION_WIDE_STATE_COUNTERS,
	VERSION_WITH_METADATA,
	WIDE_STATE_ENTRY_SIZE,
} from "#fst/format"
import type { FSTNode } from "#fst/matcher"
import { FSTMatcher } from "#fst/matcher"
import type { FSTProvenance, PlaceEntry } from "#fst/types"

/**
 * Re-exports the format version that {@link serializeFST} writes.
 */
export { FST_FORMAT_VERSION } from "#fst/format"

const MAGIC = Buffer.from(FST_MAGIC_BYTES)

/**
 * The longest parent chain stored per place.
 *
 * The writer keeps the first eight valid parent ids and drops the rest.
 */
const MAX_CHAIN_LEN = 8

const placetypeToIdx = new Map<string, number>()

for (let i = 0; i < PLACETYPE_ORDER.length; i++) {
	placetypeToIdx.set(PLACETYPE_ORDER[i]!, i)
}

/**
 * Serializes a matcher, with optional provenance, into the current FST binary format.
 */
export function serializeFST(matcher: FSTMatcher, provenance?: FSTProvenance): Buffer {
	const nodes = matcher.toNodes() as FSTNode[]

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

	let totalEdges = 0
	let totalPlaces = 0

	for (const node of nodes) {
		totalEdges += node.edges.size
		totalPlaces += node.places.length
	}

	const stringTableSize = (strings.length + 1) * 4 + stringBytes
	const stateTableSize = nodes.length * WIDE_STATE_ENTRY_SIZE
	const edgeTableSize = totalEdges * EDGE_ENTRY_SIZE
	const placeTableSize = totalPlaces * SPLIT_PLACE_ENTRY_SIZE
	const provenanceJson = provenance ? Buffer.from(stringifyJSON(provenance), "utf8") : null
	const provenanceSize = provenanceJson ? 4 + provenanceJson.length : 0
	const binarySize = HEADER_SIZE + stringTableSize + stateTableSize + edgeTableSize + placeTableSize
	const totalSize = binarySize + provenanceSize
	const buf = Buffer.alloc(totalSize)
	let pos = 0

	// Flag bit 0 marks that place rows carry `crossCountryBranches`.
	// Readers of a file without it report `undefined`.
	const hasAmbiguity = nodes.some((n) => n.places.some((p) => p.crossCountryBranches !== undefined))
	MAGIC.copy(buf, pos)
	pos += 4
	buf.writeUInt16LE(FST_FORMAT_VERSION, pos)
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

	let strOffset = 0

	for (const encoded of encodedStrings) {
		buf.writeUInt32LE(strOffset, pos)
		pos += 4
		strOffset += encoded.length
	}

	// The final offset is the sentinel that ends the last string.
	buf.writeUInt32LE(strOffset, pos)
	pos += 4

	for (const encoded of encodedStrings) {
		encoded.copy(buf, pos)
		pos += encoded.length
	}

	const stateTableStart = pos
	const edgeTableStart = stateTableStart + stateTableSize
	const placeTableStart = edgeTableStart + edgeTableSize

	let edgeIdx = 0
	let placeIdx = 0

	for (let si = 0; si < nodes.length; si++) {
		const node = nodes[si]!
		const sp = stateTableStart + si * WIDE_STATE_ENTRY_SIZE

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
			const pp = placeTableStart + placeIdx * SPLIT_PLACE_ENTRY_SIZE
			// WOF uses negative parent ids such as -1 as sentinels.
			const validChain = place.parentChain.filter((id) => id > 0)
			const chainLen = Math.min(validChain.length, MAX_CHAIN_LEN)
			buf.writeUInt32LE(place.wofID, pp)
			buf.writeUInt8(placetypeToIdx.get(place.placetype) ?? 0, pp + 4)
			buf.writeUInt8(chainLen, pp + 5)
			buf.writeUInt8(hasAmbiguity ? Math.min(place.crossCountryBranches ?? 0, 255) : 0, pp + 6)
			// An absent encyclopedic score writes flag 0 and a 0.0 float, and readers skip the float when the flag is 0.
			const hasEncyclopedic = place.encyclopedic !== undefined
			buf.writeUInt8(hasEncyclopedic ? PLACE_FLAG_HAS_ENCYCLOPEDIC : 0, pp + 7)
			buf.writeUInt32LE(intern(place.name), pp + 8)
			buf.writeFloatLE(place.referential, pp + 12)
			buf.writeFloatLE(place.lat, pp + 16)
			buf.writeFloatLE(place.lon, pp + 20)

			for (let ci = 0; ci < MAX_CHAIN_LEN; ci++) {
				buf.writeUInt32LE(ci < chainLen ? validChain[ci]! : 0, pp + 24 + ci * 4)
			}

			buf.writeFloatLE(hasEncyclopedic ? place.encyclopedic! : 0, pp + ENCYCLOPEDIC_OFFSET)

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

/**
 * Deserializes an FST binary of any supported version into a matcher.
 *
 * @throws When the buffer is too small, has the wrong magic, or has an unsupported version.
 */
export function deserializeFST(buf: Buffer): FSTMatcher {
	if (buf.length < HEADER_SIZE) throw new Error("FST buffer too small for header")

	if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error("FST magic mismatch")
	const version = buf.readUInt16LE(4)

	if (version < 1 || version > FST_FORMAT_VERSION) {
		throw new Error(`FST version ${version} unsupported (expected 1..${FST_FORMAT_VERSION})`)
	}

	const isV2 = version >= 2
	const isSplit = version >= VERSION_TWO_SCORE_SPLIT
	const hasAmbiguity = (buf.readUInt16LE(6) & 1) === 1

	const stateCount = buf.readUInt32LE(8)
	const edgeCount = buf.readUInt32LE(12)
	const _placeCount = buf.readUInt32LE(16)
	const stringCount = buf.readUInt32LE(20)
	const stringBytes = buf.readUInt32LE(24)

	let pos = HEADER_SIZE

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

	const stateEntrySize = version >= VERSION_WIDE_STATE_COUNTERS ? WIDE_STATE_ENTRY_SIZE : NARROW_STATE_ENTRY_SIZE
	const placeEntrySize = version >= VERSION_TWO_SCORE_SPLIT ? SPLIT_PLACE_ENTRY_SIZE : LEGACY_PLACE_ENTRY_SIZE
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
			const pp = placeTableStart + (placeStart + pi) * placeEntrySize
			const chainLen = buf.readUInt8(pp + 5)
			const parentChain: number[] = []

			for (let ci = 0; ci < chainLen; ci++) {
				parentChain.push(buf.readUInt32LE(pp + 24 + ci * 4))
			}

			// Version 1 stored a raw population u32 here, which this maps through the
			// `referentialFromPopulation` curve.
			// Later versions store an f32 score.
			const referential = isV2
				? buf.readFloatLE(pp + 12)
				: Math.min(1, Math.log2(1 + buf.readUInt32LE(pp + 12) / 1000) / 14)

			// Files before version 5 have no encyclopedic score, so their reserved byte is not read as a flag.
			const hasEncyclopedic =
				isSplit && (buf.readUInt8(pp + 7) & PLACE_FLAG_HAS_ENCYCLOPEDIC) === PLACE_FLAG_HAS_ENCYCLOPEDIC

			places[pi] = {
				wofID: buf.readUInt32LE(pp),
				placetype: PLACETYPE_ORDER[buf.readUInt8(pp + 4)] ?? "locality",
				name: strings[buf.readUInt32LE(pp + 8)]!,
				referential,
				lat: buf.readFloatLE(pp + 16),
				lon: buf.readFloatLE(pp + 20),
				parentChain,
				...(hasAmbiguity ? { crossCountryBranches: buf.readUInt8(pp + 6) } : {}),
				...(hasEncyclopedic ? { encyclopedic: buf.readFloatLE(pp + ENCYCLOPEDIC_OFFSET) } : {}),
			}
		}

		nodes[si] = { edges, places }
	}

	return FSTMatcher.fromNodes(nodes)
}

/**
 * Reads the provenance trailer from an FST binary, or returns `undefined`
 * when the file has none or it cannot be parsed.
 */
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

		return tryParsingJSON<FSTProvenance>(jsonStr) ?? undefined
	} catch {
		return undefined
	}
}
