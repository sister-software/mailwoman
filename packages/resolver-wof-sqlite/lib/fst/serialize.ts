// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Binary serialization for the FST gazetteer.
 *
 *   All integers are little-endian. The writer emits the current version. The reader accepts every earlier version.
 *
 *   - Header, 32 bytes: magic `FST\0`, version u16, flags u16 (bit 0 means `crossCountryBranches` is present),
 *     The header stores five u32 counts (stateCount, edgeCount, placeCount, stringCount, stringBytes).
 *     Its provenance offset is u32. The value 0 means the trailer is absent.
 *   - The string table contains `stringCount + 1` u32 offsets, with the final offset as a sentinel, followed by the UTF-8 data.
 *   - State table, 16 bytes per state: edgeStart u32, placeStart u32, edgeCount u32, placeCount u32. Before version
 *     4 the entry is 12 bytes with u16 counts.
 *   - Edge table, 8 bytes per edge: stringIdx u32, targetState u32.
 *   - Place table, 60 bytes per place: wofID u32, placetypeIdx u8, chainLen u8, crossCountryBranches u8,
 *     placeFlags u8 (bit 0 means `encyclopedic` is present), nameIdx u32, referential f32, lat f32, lon f32,
 *     eight u32 parent ids, encyclopedic f32. From version 6 the wofID and parent-id fields are indices into
 *     the id table. Before version 5 the entry is 56 bytes with no encyclopedic score.
 *   - Id table, from version 6: a u32 count, then one f64 WOF id per distinct id, ascending.
 *   - Provenance trailer: a u32 length followed by JSON.
 *
 *   Presence bits keep a missing value distinct from a stored zero.
 */

import { tryParsingJSON, stringifyJSON } from "@mailwoman/core/json"

import {
	decodePlaceEntry,
	idTableOffset,
	loadIDTable,
	EDGE_ENTRY_SIZE,
	FST_FORMAT_VERSION,
	FST_MAGIC_BYTES,
	HEADER_SIZE,
	NARROW_STATE_ENTRY_SIZE,
	PARENT_CHAIN_SLOTS,
	PLACE_FLAG_HAS_ENCYCLOPEDIC,
	PLACETYPE_ORDER,
	placeEntryLayout,
	VERSION_WIDE_STATE_COUNTERS,
	VERSION_WITH_METADATA,
	WIDE_STATE_ENTRY_SIZE,
} from "#fst/format"
import type { FSTNode } from "#fst/matcher"
import { FSTMatcher } from "#fst/matcher"
import type { FSTProvenance, PlaceEntry } from "#fst/types"

const MAGIC = Buffer.from(FST_MAGIC_BYTES)

/**
 * The place-entry layout this writer emits.
 */
const PLACE_LAYOUT = placeEntryLayout(FST_FORMAT_VERSION)

/**
 * The id table for `nodes`: every place's id and its first {@link PARENT_CHAIN_SLOTS}
 * valid parent ids, distinct and ascending, with each id's index.
 *
 * @throws When an id isn't a safe integer.
 * An f64 holds only safe integers exactly.
 */
function buildIDTable(nodes: readonly FSTNode[]): { ids: number[]; indexOf: Map<number, number> } {
	const distinct = new Set<number>()

	for (const node of nodes) {
		for (const place of node.places) {
			distinct.add(place.wofID)

			for (const id of validParentChain(place.parentChain)) {
				distinct.add(id)
			}
		}
	}

	const ids = [...distinct].toSorted((a, b) => a - b)

	for (const id of ids) {
		if (!Number.isSafeInteger(id)) throw new RangeError(`serializeFST: WOF id ${id} is not a safe integer`)
	}

	return { ids, indexOf: new Map(ids.map((id, index) => [id, index])) }
}

/**
 * The parent ids a place entry stores: the first eight positive ids,
 * since WOF uses negative ids such as -1 as sentinels.
 */
function validParentChain(chain: readonly number[]): number[] {
	return chain.filter((id) => id > 0).slice(0, PARENT_CHAIN_SLOTS)
}

const placetypeToIdx = new Map<string, number>(PLACETYPE_ORDER.map((placetype, index) => [placetype, index]))

/**
 * Serializes a matcher, with optional provenance, into the current FST binary format.
 */
export function serializeFST(matcher: FSTMatcher, provenance?: FSTProvenance): Buffer {
	const nodes = matcher.toNodes() as FSTNode[]

	const stringMap = new Map<string, number>()
	const strings: string[] = []

	function intern(s: string): number {
		let idx = stringMap.get(s)

		if (typeof idx !== "number") {
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
	const placeTableSize = totalPlaces * PLACE_LAYOUT.size
	const idTable = buildIDTable(nodes)
	const idTableSize = 4 + idTable.ids.length * 8
	const provenanceJson = provenance ? Buffer.from(stringifyJSON(provenance), "utf8") : null
	const provenanceSize = provenanceJson ? 4 + provenanceJson.length : 0
	const binarySize = HEADER_SIZE + stringTableSize + stateTableSize + edgeTableSize + placeTableSize + idTableSize
	const totalSize = binarySize + provenanceSize
	const buf = Buffer.alloc(totalSize)
	let pos = 0

	// Flag bit 0 marks that place rows include `crossCountryBranches`.
	// Readers of a file without it report `undefined`.
	const hasAmbiguity = nodes.some((n) => n.places.some((p) => p.crossCountryBranches != null))
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
			const pp = placeTableStart + placeIdx * PLACE_LAYOUT.size
			const validChain = validParentChain(place.parentChain)
			const chainLen = validChain.length
			buf.writeUInt32LE(idTable.indexOf.get(place.wofID)!, pp)
			buf.writeUInt8(placetypeToIdx.get(place.placetype) ?? 0, pp + PLACE_LAYOUT.placetype)
			buf.writeUInt8(chainLen, pp + PLACE_LAYOUT.chainLength)

			buf.writeUInt8(
				hasAmbiguity ? Math.min(place.crossCountryBranches ?? 0, 255) : 0,
				pp + PLACE_LAYOUT.crossCountryBranches
			)

			// An absent encyclopedic score writes flag 0 and a 0.0 float.
			// Readers skip the float when the flag is 0.
			const hasEncyclopedic = place.encyclopedic != null
			buf.writeUInt8(hasEncyclopedic ? PLACE_FLAG_HAS_ENCYCLOPEDIC : 0, pp + PLACE_LAYOUT.flags)
			buf.writeUInt32LE(intern(place.name), pp + PLACE_LAYOUT.name)
			buf.writeFloatLE(place.referential, pp + PLACE_LAYOUT.referential)
			buf.writeFloatLE(place.lat, pp + PLACE_LAYOUT.latitude)
			buf.writeFloatLE(place.lon, pp + PLACE_LAYOUT.longitude)

			for (let ci = 0; ci < PARENT_CHAIN_SLOTS; ci++) {
				buf.writeUInt32LE(ci < chainLen ? idTable.indexOf.get(validChain[ci]!)! : 0, pp + PLACE_LAYOUT.chain + ci * 4)
			}

			buf.writeFloatLE(place.encyclopedic ?? 0, pp + PLACE_LAYOUT.encyclopedic!)

			placeIdx++
		}
	}

	const idTableStart = idTableOffset(placeTableStart, totalPlaces, PLACE_LAYOUT)
	buf.writeUInt32LE(idTable.ids.length, idTableStart)

	for (const [index, id] of idTable.ids.entries()) {
		buf.writeDoubleLE(id, idTableStart + 4 + index * 8)
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

	const hasAmbiguity = (buf.readUInt16LE(6) & 1) === 1
	const placeLayout = placeEntryLayout(version)
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

	const stateCount = buf.readUInt32LE(8)
	const edgeCount = buf.readUInt32LE(12)
	const placeCount = buf.readUInt32LE(16)
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
	const stateTableStart = pos
	const edgeTableStart = stateTableStart + stateCount * stateEntrySize
	const placeTableStart = edgeTableStart + edgeCount * EDGE_ENTRY_SIZE
	const ids = loadIDTable(view, idTableOffset(placeTableStart, placeCount, placeLayout), placeLayout)

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
			places[pi] = decodePlaceEntry(
				view,
				placeTableStart + (placeStart + pi) * placeLayout.size,
				version,
				placeLayout,
				hasAmbiguity,
				(index) => strings[index]!,
				ids
			)
		}

		nodes[si] = { edges, places }
	}

	return FSTMatcher.fromNodes(nodes)
}

/**
 * Reads the provenance trailer from an FST binary, or returns `undefined`
 * when the file has none or it cannot be parsed.
 */
export function readFSTProvenance(buf: Buffer): FSTProvenance | null {
	if (buf.length < HEADER_SIZE) return null

	if (!buf.subarray(0, 4).equals(MAGIC)) return null
	const version = buf.readUInt16LE(4)

	if (version < VERSION_WITH_METADATA) return null
	const provenanceOffset = buf.readUInt32LE(28)

	if (provenanceOffset === 0 || provenanceOffset >= buf.length) return null

	try {
		const jsonLen = buf.readUInt32LE(provenanceOffset)
		const jsonStr = buf.toString("utf8", provenanceOffset + 4, provenanceOffset + 4 + jsonLen)

		return tryParsingJSON<FSTProvenance>(jsonStr) ?? null
	} catch {
		return null
	}
}
