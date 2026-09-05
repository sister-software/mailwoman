/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Browser-compatible FST deserializer. Uses DataView + TextDecoder instead of Node's Buffer so the
 *   same binary format can be loaded in the browser via fetch(url).then(r => r.arrayBuffer()).
 *
 *   This is a read-only counterpart to fst-serialize.ts — serialization stays Node-only (it's a
 *   build-time operation).
 */

import { tryParsingJSON } from "@mailwoman/core/json"

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

export function deserializeFSTWeb(input: ArrayBuffer | Uint8Array): FSTMatcher {
	const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const decoder = new TextDecoder("utf-8")

	if (bytes.byteLength < HEADER_SIZE) throw new Error("FST buffer too small for header")

	if (
		bytes[0] !== FST_MAGIC_BYTES[0] ||
		bytes[1] !== FST_MAGIC_BYTES[1] ||
		bytes[2] !== FST_MAGIC_BYTES[2] ||
		bytes[3] !== FST_MAGIC_BYTES[3]
	) {
		throw new Error("FST magic mismatch")
	}

	const version = view.getUint16(4, true)

	if (version < 1 || version > FST_FORMAT_VERSION) {
		throw new Error(`FST version ${version} unsupported (expected 1..${FST_FORMAT_VERSION})`)
	}

	const isV2 = version >= 2
	const isSplit = version >= VERSION_TWO_SCORE_SPLIT
	// flags bit0 (survey #4, mirrors fst-serialize.ts): place rows carry surface-ambiguity data.
	const hasAmbiguity = (view.getUint16(6, true) & 1) === 1

	const stateCount = view.getUint32(8, true)
	const edgeCount = view.getUint32(12, true)
	const _placeCount = view.getUint32(16, true)
	const stringCount = view.getUint32(20, true)
	const stringBytes = view.getUint32(24, true)

	let pos = HEADER_SIZE

	// --- String table ---
	const strOffsets = new Uint32Array(stringCount + 1)

	for (let i = 0; i <= stringCount; i++) {
		strOffsets[i] = view.getUint32(pos, true)
		pos += 4
	}

	const strDataStart = pos
	const strings: string[] = new Array(stringCount)

	for (let i = 0; i < stringCount; i++) {
		const start = strDataStart + strOffsets[i]!
		const end = strDataStart + strOffsets[i + 1]!
		strings[i] = decoder.decode(bytes.subarray(start, end))
	}

	pos += stringBytes

	// --- State table ---
	const stateEntrySize = version >= VERSION_WIDE_STATE_COUNTERS ? WIDE_STATE_ENTRY_SIZE : NARROW_STATE_ENTRY_SIZE
	// v5 grew the place entry by the encyclopedic float; v4-and-below files are read at the old stride.
	const placeEntrySize = isSplit ? SPLIT_PLACE_ENTRY_SIZE : LEGACY_PLACE_ENTRY_SIZE
	const stateTableStart = pos
	const edgeTableStart = stateTableStart + stateCount * stateEntrySize
	const placeTableStart = edgeTableStart + edgeCount * EDGE_ENTRY_SIZE

	const nodes: FSTNode[] = new Array(stateCount)

	for (let si = 0; si < stateCount; si++) {
		const sp = stateTableStart + si * stateEntrySize
		const edgeStart = view.getUint32(sp, true)
		const placeStart = view.getUint32(sp + 4, true)

		const edgeCountForState =
			version >= VERSION_WIDE_STATE_COUNTERS ? view.getUint32(sp + 8, true) : view.getUint16(sp + 8, true)

		const placeCountForState =
			version >= VERSION_WIDE_STATE_COUNTERS ? view.getUint32(sp + 12, true) : view.getUint16(sp + 10, true)

		const edges = new Map<string, number>()

		for (let ei = 0; ei < edgeCountForState; ei++) {
			const ep = edgeTableStart + (edgeStart + ei) * EDGE_ENTRY_SIZE
			const stringIdx = view.getUint32(ep, true)
			const target = view.getUint32(ep + 4, true)
			edges.set(strings[stringIdx]!, target)
		}

		const places: PlaceEntry[] = new Array(placeCountForState)

		for (let pi = 0; pi < placeCountForState; pi++) {
			const pp = placeTableStart + (placeStart + pi) * placeEntrySize
			const chainLen = view.getUint8(pp + 5)
			const parentChain: number[] = []

			for (let ci = 0; ci < chainLen; ci++) {
				parentChain.push(view.getUint32(pp + 24 + ci * 4, true))
			}

			// v1 stored a raw population u32 here; v2-v4 the conflated `importance` float; v5 the
			// referential score. See the Node deserializer for why a v1 value is genuinely referential.
			const referential = isV2
				? view.getFloat32(pp + 12, true)
				: Math.min(1, Math.log2(1 + view.getUint32(pp + 12, true) / 1000) / 14)

			const hasEncyclopedic =
				isSplit && (view.getUint8(pp + 7) & PLACE_FLAG_HAS_ENCYCLOPEDIC) === PLACE_FLAG_HAS_ENCYCLOPEDIC

			places[pi] = {
				wofID: view.getUint32(pp, true),
				placetype: PLACETYPE_ORDER[view.getUint8(pp + 4)] ?? "locality",
				name: strings[view.getUint32(pp + 8, true)]!,
				referential,
				lat: view.getFloat32(pp + 16, true),
				lon: view.getFloat32(pp + 20, true),
				parentChain,
				...(hasAmbiguity ? { crossCountryBranches: view.getUint8(pp + 6) } : {}),
				...(hasEncyclopedic ? { encyclopedic: view.getFloat32(pp + ENCYCLOPEDIC_OFFSET, true) } : {}),
			}
		}

		nodes[si] = { edges, places }
	}

	return FSTMatcher.fromNodes(nodes)
}

export function readFSTProvenanceWeb(input: ArrayBuffer | Uint8Array): FSTProvenance | undefined {
	const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const decoder = new TextDecoder("utf-8")

	if (bytes.byteLength < HEADER_SIZE) return undefined
	const version = view.getUint16(4, true)

	if (version < VERSION_WITH_METADATA) return undefined
	const provenanceOffset = view.getUint32(28, true)

	if (provenanceOffset === 0 || provenanceOffset >= bytes.byteLength) return undefined

	try {
		const jsonLen = view.getUint32(provenanceOffset, true)
		const jsonStr = decoder.decode(bytes.subarray(provenanceOffset + 4, provenanceOffset + 4 + jsonLen))

		return tryParsingJSON<FSTProvenance>(jsonStr) ?? undefined
	} catch {
		return undefined
	}
}
