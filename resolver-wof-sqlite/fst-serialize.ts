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

import type { FSTNode } from "./fst-matcher.js"
import { FSTMatcher } from "./fst-matcher.js"
import type { FSTProvenance, PlaceEntry, PlacetypeId } from "./fst-types.js"

const MAGIC = Buffer.from("FST\0", "ascii")
const VERSION = 4
const HEADER_SIZE = 32
const STATE_ENTRY_SIZE = 16
const EDGE_ENTRY_SIZE = 8
const PLACE_ENTRY_SIZE = 56
const MAX_CHAIN_LEN = 8

const PLACETYPE_ORDER: readonly PlacetypeId[] = [
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
		for (const token of node.edges.keys()) intern(token)

		for (const place of node.places) intern(place.name)
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
	MAGIC.copy(buf, pos)
	pos += 4
	buf.writeUInt16LE(VERSION, pos)
	pos += 2
	buf.writeUInt16LE(0, pos)
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

	for (let i = 0; i < encodedStrings.length; i++) {
		buf.writeUInt32LE(strOffset, pos)
		pos += 4
		strOffset += encodedStrings[i]!.length
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
			buf.writeUInt16LE(0, pp + 6) // pad
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
	const stateEntrySize = version >= 4 ? 16 : 12
	const stateTableStart = pos
	const edgeTableStart = stateTableStart + stateCount * stateEntrySize
	const placeTableStart = edgeTableStart + edgeCount * EDGE_ENTRY_SIZE

	const nodes: FSTNode[] = new Array(stateCount)

	for (let si = 0; si < stateCount; si++) {
		const sp = stateTableStart + si * stateEntrySize
		const edgeStart = buf.readUInt32LE(sp)
		const placeStart = buf.readUInt32LE(sp + 4)
		const edgeCountForState = version >= 4 ? buf.readUInt32LE(sp + 8) : buf.readUInt16LE(sp + 8)
		const placeCountForState = version >= 4 ? buf.readUInt32LE(sp + 12) : buf.readUInt16LE(sp + 10)

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
				: Math.min(1.0, Math.log2(1 + buf.readUInt32LE(pp + 12) / 1000) / 14)
			places[pi] = {
				wofID: buf.readUInt32LE(pp),
				placetype: PLACETYPE_ORDER[buf.readUInt8(pp + 4)] ?? "locality",
				name: strings[buf.readUInt32LE(pp + 8)]!,
				importance: rawImportance,
				lat: buf.readFloatLE(pp + 16),
				lon: buf.readFloatLE(pp + 20),
				parentChain,
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

	if (version < 3) return undefined
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
