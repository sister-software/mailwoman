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

import type { FSTNode } from "./fst-matcher.js"
import { FSTMatcher } from "./fst-matcher.js"
import type { FSTProvenance, PlaceEntry, PlacetypeId } from "./fst-types.js"

const HEADER_SIZE = 32
const EDGE_ENTRY_SIZE = 8
const PLACE_ENTRY_SIZE = 56
const MAGIC_BYTES = [0x46, 0x53, 0x54, 0x00] // "FST\0"
// Must track the serializer's VERSION (fst-serialize.ts, currently 4). The v3 provenance + v4
// 16-byte-state/u32-count layout logic below already matches the Node deserializer; only this gate
// was left stale at 2, so the browser FST loader rejected every real (v4) artifact.
const MAX_VERSION = 4

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

export function deserializeFSTWeb(input: ArrayBuffer | Uint8Array): FSTMatcher {
	const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const decoder = new TextDecoder("utf-8")

	if (bytes.byteLength < HEADER_SIZE) throw new Error("FST buffer too small for header")

	if (
		bytes[0] !== MAGIC_BYTES[0] ||
		bytes[1] !== MAGIC_BYTES[1] ||
		bytes[2] !== MAGIC_BYTES[2] ||
		bytes[3] !== MAGIC_BYTES[3]
	) {
		throw new Error("FST magic mismatch")
	}

	const version = view.getUint16(4, true)

	if (version < 1 || version > MAX_VERSION) {
		throw new Error(`FST version ${version} unsupported (expected 1..${MAX_VERSION})`)
	}
	const isV2 = version >= 2

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
	const stateEntrySize = version >= 4 ? 16 : 12
	const stateTableStart = pos
	const edgeTableStart = stateTableStart + stateCount * stateEntrySize
	const placeTableStart = edgeTableStart + edgeCount * EDGE_ENTRY_SIZE

	const nodes: FSTNode[] = new Array(stateCount)

	for (let si = 0; si < stateCount; si++) {
		const sp = stateTableStart + si * stateEntrySize
		const edgeStart = view.getUint32(sp, true)
		const placeStart = view.getUint32(sp + 4, true)
		const edgeCountForState = version >= 4 ? view.getUint32(sp + 8, true) : view.getUint16(sp + 8, true)
		const placeCountForState = version >= 4 ? view.getUint32(sp + 12, true) : view.getUint16(sp + 10, true)

		const edges = new Map<string, number>()

		for (let ei = 0; ei < edgeCountForState; ei++) {
			const ep = edgeTableStart + (edgeStart + ei) * EDGE_ENTRY_SIZE
			const stringIdx = view.getUint32(ep, true)
			const target = view.getUint32(ep + 4, true)
			edges.set(strings[stringIdx]!, target)
		}

		const places: PlaceEntry[] = new Array(placeCountForState)

		for (let pi = 0; pi < placeCountForState; pi++) {
			const pp = placeTableStart + (placeStart + pi) * PLACE_ENTRY_SIZE
			const chainLen = view.getUint8(pp + 5)
			const parentChain: number[] = []

			for (let ci = 0; ci < chainLen; ci++) {
				parentChain.push(view.getUint32(pp + 24 + ci * 4, true))
			}
			const rawImportance = isV2
				? view.getFloat32(pp + 12, true)
				: Math.min(1.0, Math.log2(1 + view.getUint32(pp + 12, true) / 1000) / 14)

			places[pi] = {
				wofID: view.getUint32(pp, true),
				placetype: PLACETYPE_ORDER[view.getUint8(pp + 4)] ?? "locality",
				name: strings[view.getUint32(pp + 8, true)]!,
				importance: rawImportance,
				lat: view.getFloat32(pp + 16, true),
				lon: view.getFloat32(pp + 20, true),
				parentChain,
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

	if (version < 3) return undefined
	const provenanceOffset = view.getUint32(28, true)

	if (provenanceOffset === 0 || provenanceOffset >= bytes.byteLength) return undefined

	try {
		const jsonLen = view.getUint32(provenanceOffset, true)
		const jsonStr = decoder.decode(bytes.subarray(provenanceOffset + 4, provenanceOffset + 4 + jsonLen))

		return JSON.parse(jsonStr) as FSTProvenance
	} catch {
		return undefined
	}
}
