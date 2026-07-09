/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the browser-compatible FST deserializer. Hand-builds minimal binary fixtures in the
 *   on-disk FST format (header + string table + state/edge/place tables) so the pure
 *   DataView/TextDecoder parsing can be exercised without a real `.bin` artifact or DB.
 *
 *   Fixtures are written at version 2 — the highest the web reader claims to support (`MAX_VERSION`)
 *   — using the v1/v2 layout (12-byte state entries, u16 per-state counts), per fst-serialize.ts.
 */

import { describe, expect, test } from "vitest"

import { deserializeFSTWeb, readFSTProvenanceWeb } from "./fst-deserialize-web.ts"

const HEADER_SIZE = 32
const EDGE_ENTRY_SIZE = 8
const PLACE_ENTRY_SIZE = 56
const STATE_ENTRY_SIZE_V2 = 12 // version < 4
const MAGIC = [0x46, 0x53, 0x54, 0x00] // "FST\0"

const PLACETYPE_ORDER = [
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
] as const

interface FixturePlace {
	wofID: number
	placetype: (typeof PLACETYPE_ORDER)[number]
	name: string
	importance: number // raw float32 (v2 semantics)
	lat: number
	lon: number
	parentChain?: number[]
}

interface FixtureNode {
	edges: Array<[token: string, target: number]>
	places: FixturePlace[]
}

interface BuildOpts {
	version?: number
	provenance?: unknown
}

/**
 * Builds a minimal valid FST binary buffer in the v1/v2 layout. Mirrors fst-serialize.ts closely enough to round-trip
 * through the web deserializer, but kept hand-rolled so the test asserts the format the reader actually expects (not
 * whatever the Node serializer happens to emit at v4).
 */
function buildFSTBuffer(nodes: FixtureNode[], opts: BuildOpts = {}): Uint8Array {
	const version = opts.version ?? 2

	// --- Intern strings (edge tokens, then place names), first-seen order. ---
	const stringMap = new Map<string, number>()
	const strings: string[] = []
	const intern = (s: string): number => {
		let idx = stringMap.get(s)

		if (idx === undefined) {
			idx = strings.length
			strings.push(s)
			stringMap.set(s, idx)
		}

		return idx
	}

	for (const node of nodes) {
		for (const [token] of node.edges) {
			intern(token)
		}

		for (const place of node.places) {
			intern(place.name)
		}
	}

	const enc = new TextEncoder()
	const encodedStrings = strings.map((s) => enc.encode(s))
	const stringBytes = encodedStrings.reduce((sum, b) => sum + b.length, 0)

	let totalEdges = 0
	let totalPlaces = 0

	for (const node of nodes) {
		totalEdges += node.edges.length
		totalPlaces += node.places.length
	}

	const stringTableSize = (strings.length + 1) * 4 + stringBytes
	const stateTableSize = nodes.length * STATE_ENTRY_SIZE_V2
	const edgeTableSize = totalEdges * EDGE_ENTRY_SIZE
	const placeTableSize = totalPlaces * PLACE_ENTRY_SIZE

	const provJson = opts.provenance ? enc.encode(JSON.stringify(opts.provenance)) : null
	const provSize = provJson ? 4 + provJson.length : 0
	const binarySize = HEADER_SIZE + stringTableSize + stateTableSize + edgeTableSize + placeTableSize
	const totalSize = binarySize + provSize

	const bytes = new Uint8Array(totalSize)
	const view = new DataView(bytes.buffer)
	let pos = 0

	// --- Header ---
	bytes.set(MAGIC, 0)
	pos = 4
	view.setUint16(pos, version, true)
	pos += 2
	view.setUint16(pos, 0, true) // flags
	pos += 2
	view.setUint32(pos, nodes.length, true)
	pos += 4
	view.setUint32(pos, totalEdges, true)
	pos += 4
	view.setUint32(pos, totalPlaces, true)
	pos += 4
	view.setUint32(pos, strings.length, true)
	pos += 4
	view.setUint32(pos, stringBytes, true)
	pos += 4
	view.setUint32(pos, provJson ? binarySize : 0, true) // provenance offset at byte 28
	pos += 4

	// --- String table: offsets[stringCount + 1], then concatenated UTF-8 ---
	let strOffset = 0

	for (const encoded of encodedStrings) {
		view.setUint32(pos, strOffset, true)
		pos += 4
		strOffset += encoded.length
	}
	view.setUint32(pos, strOffset, true) // sentinel
	pos += 4

	for (const encoded of encodedStrings) {
		bytes.set(encoded, pos)
		pos += encoded.length
	}

	// --- State / edge / place tables ---
	const stateTableStart = pos
	const edgeTableStart = stateTableStart + stateTableSize
	const placeTableStart = edgeTableStart + edgeTableSize

	let edgeIdx = 0
	let placeIdx = 0

	for (let si = 0; si < nodes.length; si++) {
		const node = nodes[si]!
		const sp = stateTableStart + si * STATE_ENTRY_SIZE_V2
		view.setUint32(sp, edgeIdx, true) // edgeStart
		view.setUint32(sp + 4, placeIdx, true) // placeStart
		view.setUint16(sp + 8, node.edges.length, true) // edgeCount (u16)
		view.setUint16(sp + 10, node.places.length, true)

		// placeCount (u16)

		for (const [token, target] of node.edges) {
			const ep = edgeTableStart + edgeIdx * EDGE_ENTRY_SIZE
			view.setUint32(ep, intern(token), true)
			view.setUint32(ep + 4, target, true)
			edgeIdx++
		}

		for (const place of node.places) {
			const pp = placeTableStart + placeIdx * PLACE_ENTRY_SIZE
			const chain = (place.parentChain ?? []).slice(0, 8)
			view.setUint32(pp, place.wofID, true)
			view.setUint8(pp + 4, PLACETYPE_ORDER.indexOf(place.placetype))
			view.setUint8(pp + 5, chain.length)
			view.setUint16(pp + 6, 0, true) // pad
			view.setUint32(pp + 8, intern(place.name), true)

			// importance: float32 for v2; for v1 the field is interpreted as a raw population u32.
			if (version >= 2) {
				view.setFloat32(pp + 12, place.importance, true)
			} else {
				view.setUint32(pp + 12, place.importance, true)
			}
			view.setFloat32(pp + 16, place.lat, true)
			view.setFloat32(pp + 20, place.lon, true)

			for (let ci = 0; ci < chain.length; ci++) {
				view.setUint32(pp + 24 + ci * 4, chain[ci]!, true)
			}
			placeIdx++
		}
	}

	if (provJson) {
		view.setUint32(binarySize, provJson.length, true)
		bytes.set(provJson, binarySize + 4)
	}

	return bytes
}

// A reusable 2-state FST: state 0 --"paris"--> state 1 (accepting "Paris").
const PARIS_FIXTURE: FixtureNode[] = [
	{ edges: [["paris", 1]], places: [] },
	{
		edges: [],
		places: [
			{
				wofID: 101748479,
				placetype: "locality",
				name: "Paris",
				importance: 0.95,
				lat: 48.8566,
				lon: 2.3522,
				parentChain: [85633147, 85632343],
			},
		],
	},
]

//#region deserializeFSTWeb — happy path

describe("deserializeFSTWeb", () => {
	test("round-trips a 2-state FST: node + place counts", () => {
		const matcher = deserializeFSTWeb(buildFSTBuffer(PARIS_FIXTURE))

		expect(matcher.stateCount).toBe(2)
		expect(matcher.placeCount).toBe(1)
	})

	test("walking the gold token reaches the accepting state", () => {
		const matcher = deserializeFSTWeb(buildFSTBuffer(PARIS_FIXTURE))

		const result = matcher.walk(["paris"])
		expect(result).not.toBeNull()
		expect(result!.accepted).toBe(true)
		expect(result!.depth).toBe(1)
	})

	test("an unknown token falls off the trie (no walk)", () => {
		const matcher = deserializeFSTWeb(buildFSTBuffer(PARIS_FIXTURE))

		expect(matcher.walk(["london"])).toBeNull()
	})

	test("decodes the place entry's scalar fields exactly", () => {
		const matcher = deserializeFSTWeb(buildFSTBuffer(PARIS_FIXTURE))
		const place = matcher.accepting(matcher.walk(["paris"])!.stateID)[0]!

		expect(place.wofID).toBe(101748479)
		expect(place.placetype).toBe("locality")
		expect(place.name).toBe("Paris")
		expect(place.importance).toBeCloseTo(0.95, 5)
		expect(place.lat).toBeCloseTo(48.8566, 3)
		expect(place.lon).toBeCloseTo(2.3522, 3)
	})

	test("reconstructs the parent chain (chainLen entries)", () => {
		const matcher = deserializeFSTWeb(buildFSTBuffer(PARIS_FIXTURE))
		const place = matcher.accepting(1)[0]!

		expect(place.parentChain).toEqual([85633147, 85632343])
	})

	test("placetypeIdx decodes via PLACETYPE_ORDER (region, not locality)", () => {
		const nodes: FixtureNode[] = [
			{ edges: [["x", 1]], places: [] },
			{ edges: [], places: [{ wofID: 1, placetype: "region", name: "X", importance: 0.1, lat: 0, lon: 0 }] },
		]
		const place = deserializeFSTWeb(buildFSTBuffer(nodes)).accepting(1)[0]!

		expect(place.placetype).toBe("region")
	})

	test("accepts a Uint8Array as well as an ArrayBuffer", () => {
		const u8 = buildFSTBuffer(PARIS_FIXTURE)
		const fromU8 = deserializeFSTWeb(u8)
		const fromAb = deserializeFSTWeb(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength))

		expect(fromU8.placeCount).toBe(1)
		expect(fromAb.placeCount).toBe(1)
	})
})

//#endregion

//#region deserializeFSTWeb — v1 importance derivation

test("deserializeFSTWeb: v1 derives importance from a population u32 via the log2 curve", () => {
	// v1 stores population (u32) in the importance slot; the reader maps it through
	// min(1, log2(1 + pop/1000) / 14). For pop = 1000: log2(2)/14 = 1/14 ≈ 0.0714.
	const nodes: FixtureNode[] = [
		{ edges: [["t", 1]], places: [] },
		{ edges: [], places: [{ wofID: 1, placetype: "locality", name: "T", importance: 1000, lat: 0, lon: 0 }] },
	]
	const matcher = deserializeFSTWeb(buildFSTBuffer(nodes, { version: 1 }))
	const place = matcher.accepting(1)[0]!

	expect(place.importance).toBeCloseTo(1 / 14, 4)
})

//#endregion

//#region deserializeFSTWeb — error paths

test("deserializeFSTWeb: a buffer shorter than the header throws", () => {
	expect(() => deserializeFSTWeb(new Uint8Array(HEADER_SIZE - 1))).toThrow(/too small/i)
})

test("deserializeFSTWeb: a bad magic throws", () => {
	const bytes = buildFSTBuffer(PARIS_FIXTURE)
	bytes[0] = 0x00 // corrupt the "F"
	expect(() => deserializeFSTWeb(bytes)).toThrow(/magic mismatch/i)
})

test("deserializeFSTWeb: version 0 is rejected", () => {
	const bytes = buildFSTBuffer(PARIS_FIXTURE)
	new DataView(bytes.buffer).setUint16(4, 0, true)
	expect(() => deserializeFSTWeb(bytes)).toThrow(/version 0 unsupported/i)
})

test("deserializeFSTWeb: a version above MAX_VERSION (now 4) is rejected", () => {
	// MAX_VERSION tracks the serializer's VERSION (4): v3/v4 parse, v5+ is rejected.
	const bytes = buildFSTBuffer(PARIS_FIXTURE)
	new DataView(bytes.buffer).setUint16(4, 5, true)
	expect(() => deserializeFSTWeb(bytes)).toThrow(/version 5 unsupported/i)
})

//#endregion

//#region readFSTProvenanceWeb

const PROVENANCE = {
	builtAt: "2026-06-25T00:00:00Z",
	countries: ["FR"],
	stateCount: 2,
	placeCount: 1,
	edgeCount: 1,
	nameInsertions: 1,
	importanceMatches: 1,
}

test("readFSTProvenanceWeb: returns undefined for versions below 3 (no trailer support)", () => {
	// A v2 buffer never carries provenance the reader will read — version gate is `< 3`.
	const bytes = buildFSTBuffer(PARIS_FIXTURE, { version: 2, provenance: PROVENANCE })
	expect(readFSTProvenanceWeb(bytes)).toBeUndefined()
})

test("readFSTProvenanceWeb: parses the JSON trailer for a v3 buffer", () => {
	const bytes = buildFSTBuffer(PARIS_FIXTURE, { version: 3, provenance: PROVENANCE })
	expect(readFSTProvenanceWeb(bytes)).toEqual(PROVENANCE)
})

test("readFSTProvenanceWeb: a v3 buffer with no trailer (offset 0) returns undefined", () => {
	const bytes = buildFSTBuffer(PARIS_FIXTURE, { version: 3 })
	// offset field at byte 28 is 0 when no provenance was written.
	expect(readFSTProvenanceWeb(bytes)).toBeUndefined()
})

test("readFSTProvenanceWeb: a buffer shorter than the header returns undefined", () => {
	expect(readFSTProvenanceWeb(new Uint8Array(HEADER_SIZE - 1))).toBeUndefined()
})

test("readFSTProvenanceWeb: a corrupt trailer (bad JSON) is swallowed to undefined", () => {
	const bytes = buildFSTBuffer(PARIS_FIXTURE, { version: 3, provenance: PROVENANCE })
	const view = new DataView(bytes.buffer)
	const offset = view.getUint32(28, true)
	// Overwrite the first JSON byte with a non-"{" so JSON.parse throws.
	bytes[offset + 4] = 0x21 // "!"
	expect(readFSTProvenanceWeb(bytes)).toBeUndefined()
})

//#endregion
