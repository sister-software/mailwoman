/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { existsSync } from "node:fs"

import { beforeAll, describe, expect, it } from "vitest"

import { buildFSTFromWOF } from "./fst-builder.ts"
import { FSTMatcher, type FSTNode } from "./fst-matcher.ts"
import { deserializeFST, serializeFST } from "./fst-serialize.ts"

// --- Unit tests with a synthetic trie ---

function buildSyntheticFST(): FSTMatcher {
	const nodes: FSTNode[] = [
		{ edges: new Map(), places: [] }, // root (0)
		{ edges: new Map(), places: [] }, // "new" (1)
		{
			edges: new Map(),
			places: [
				{
					wofID: 85_977_539,
					placetype: "locality",
					name: "New York City",
					parentChain: [85_688_543, 85_633_793],
					importance: 0.95,
					lat: 40.7128,
					lon: -74.006,
				},
				{
					wofID: 85_688_543,
					placetype: "region",
					name: "New York",
					parentChain: [85_633_793],
					importance: 0.85,
					lat: 42.1657,
					lon: -74.9481,
				},
			],
		}, // "york" (2)
		{
			edges: new Map(),
			places: [
				{
					wofID: 85_688_735,
					placetype: "locality",
					name: "Portland",
					parentChain: [85_688_513, 85_633_793],
					importance: 0.72,
					lat: 45.5152,
					lon: -122.6784,
				},
			],
		}, // "portland" (3)
	]

	// Wire edges: root -"new"-> 1 -"york"-> 2, root -"portland"-> 3
	nodes[0]!.edges.set("new", 1)
	nodes[0]!.edges.set("portland", 3)
	nodes[1]!.edges.set("york", 2)

	return FSTMatcher.fromNodes(nodes)
}

describe("FST binary serialization — unit (synthetic)", () => {
	const original = buildSyntheticFST()
	const buf = serializeFST(original)
	const restored = deserializeFST(buf)

	it("roundtrips state count", () => {
		expect(restored.stateCount).toBe(original.stateCount)
	})

	it("roundtrips place count", () => {
		expect(restored.placeCount).toBe(original.placeCount)
	})

	it("roundtrips 'New York' query", () => {
		const orig = original.query("New York")
		const rest = restored.query("New York")
		expect(rest.accepting).toHaveLength(orig.accepting.length)
		expect(rest.accepting.map((p) => p.wofID).toSorted()).toEqual(orig.accepting.map((p) => p.wofID).toSorted())
	})

	it("roundtrips place entry fields exactly", () => {
		const orig = original.query("New York")
		const rest = restored.query("New York")
		const origNyc = orig.accepting.find((p) => p.placetype === "locality")!
		const restNyc = rest.accepting.find((p) => p.placetype === "locality")!
		expect(restNyc.wofID).toBe(origNyc.wofID)
		expect(restNyc.placetype).toBe(origNyc.placetype)
		expect(restNyc.name).toBe(origNyc.name)
		expect(restNyc.importance).toBeCloseTo(origNyc.importance, 5)
		expect(restNyc.parentChain).toEqual(origNyc.parentChain)
		expect(restNyc.lat).toBeCloseTo(origNyc.lat, 3)
		expect(restNyc.lon).toBeCloseTo(origNyc.lon, 3)
	})

	it("roundtrips 'Portland' query", () => {
		const orig = original.query("Portland")
		const rest = restored.query("Portland")
		expect(rest.accepting).toHaveLength(orig.accepting.length)
		expect(rest.accepting[0]!.wofID).toBe(orig.accepting[0]!.wofID)
	})

	it("roundtrips continuations", () => {
		const orig = original.query("New")
		const rest = restored.query("New")
		expect(rest.continuations.map((c) => c.token).toSorted()).toEqual(orig.continuations.map((c) => c.token).toSorted())
	})

	it("roundtrips negative evidence (unknown tokens)", () => {
		const orig = original.query("Xyzzyplugh")
		const rest = restored.query("Xyzzyplugh")
		expect(rest.accepting).toEqual(orig.accepting)
		expect(rest.path).toEqual(orig.path)
	})

	it("produces a compact buffer", () => {
		expect(buf.length).toBeLessThan(1024)
		expect(buf.subarray(0, 4).toString("ascii")).toBe("FST\0")
	})
})

// --- Integration tests with real WOF data ---

const WOF_DB = "/mnt/playpen/mailwoman-data/wof/whosonfirst-data-admin-us-latest.db"
const HAS_WOF = existsSync(WOF_DB)

describe.skipIf(!HAS_WOF)("FST binary serialization — integration (WOF)", () => {
	let original: FSTMatcher
	let buf: Buffer
	let restored: FSTMatcher

	beforeAll(() => {
		const { matcher } = buildFSTFromWOF({
			dbPath: WOF_DB,
			countries: ["US"],
			placetypes: ["country", "region", "county", "locality"],
			languages: ["eng", ""],
			onProgress: (phase, detail) => {
				if (phase === "done") {
					console.log(`  ${phase}: ${detail}`)
				}
			},
		})

		original = matcher
		buf = serializeFST(original)
		restored = deserializeFST(buf)
	}, 60_000)

	it("roundtrips state count", () => {
		expect(restored.stateCount).toBe(original.stateCount)
	})

	it("roundtrips place count", () => {
		expect(restored.placeCount).toBe(original.placeCount)
	})

	it("'New York' produces identical interpretations", () => {
		const orig = original.query("New York")
		const rest = restored.query("New York")
		expect(rest.accepting).toHaveLength(orig.accepting.length)
		const origIds = orig.accepting.map((p) => p.wofID).toSorted()
		const restIds = rest.accepting.map((p) => p.wofID).toSorted()
		expect(restIds).toEqual(origIds)
	})

	it("NYC parent chain survives roundtrip", () => {
		const rest = restored.query("New York")
		const nyc = rest.accepting.find((p) => p.placetype === "locality" && p.wofID === 85_977_539)
		expect(nyc).toBeDefined()
		expect(nyc!.wofID).toBe(85_977_539)
		expect(nyc!.parentChain).toContain(85_688_543)
	})

	it("'Portland' produces identical localities", () => {
		const orig = original.query("Portland")
		const rest = restored.query("Portland")
		expect(rest.accepting).toHaveLength(orig.accepting.length)
	})

	it("continuations match after roundtrip", () => {
		const orig = original.query("New")
		const rest = restored.query("New")
		const origTokens = orig.continuations.map((c) => c.token).toSorted()
		const restTokens = rest.continuations.map((c) => c.token).toSorted()
		expect(restTokens).toEqual(origTokens)
	})

	it("negative evidence for 'Buffalo Health Clinic' matches", () => {
		const orig = original.query("Buffalo Health Clinic")
		const rest = restored.query("Buffalo Health Clinic")
		expect(rest.path).toEqual(orig.path)
		expect(rest.accepting).toHaveLength(orig.accepting.length)
	})

	it("binary size is reasonable", () => {
		const mb = buf.length / (1024 * 1024)

		console.log(`  FST binary: ${mb.toFixed(2)} MB (${buf.length} bytes)`)

		expect(mb).toBeLessThan(30)
		expect(mb).toBeGreaterThan(1)
	})
})

describe("surface-ambiguity classes (survey #4) — header flags bit0 + the former _pad byte", () => {
	function ambiguousMatcher(): FSTMatcher {
		const nodes: FSTNode[] = [
			{ edges: new Map(), places: [] },
			{
				edges: new Map(),
				places: [
					{
						wofID: 101,
						placetype: "locality",
						name: "Pierre",
						parentChain: [],
						importance: 0.4,
						lat: 44.36,
						lon: -100.35,
						crossCountryBranches: 7,
					},
				],
			},
		]

		nodes[0]!.edges.set("pierre", 1)

		return FSTMatcher.fromNodes(nodes)
	}

	it("roundtrips crossCountryBranches when present, with the header flag set", () => {
		const bytes = serializeFST(ambiguousMatcher())

		expect(bytes.readUInt16LE(6) & 1).toBe(1)
		const restored = deserializeFST(bytes)
		const q = restored.query("Pierre")

		expect(q.accepting[0]!.crossCountryBranches).toBe(7)
	})

	it("pre-ambiguity artifacts expose undefined, never a fake zero", () => {
		const plain = buildSyntheticFST()
		const bytes = serializeFST(plain)

		expect(bytes.readUInt16LE(6) & 1).toBe(0)
		const restored = deserializeFST(bytes)
		const q = restored.query("New York")

		expect(q.accepting[0]!.crossCountryBranches).toBeUndefined()
	})

	it("mixed presence still flags the header and defaults absent entries to 0 in-band", () => {
		const m = ambiguousMatcher()

		// an entry WITHOUT the field alongside one with it — the writer records 0 for it, and since the
		// header flag is set the reader reports 0 (a build that opted in but had no count for a surface)
		m.nodes[1]!.places.push({
			wofID: 102,
			placetype: "locality",
			name: "Pierre Part",
			parentChain: [],
			importance: 0.1,
			lat: 29.96,
			lon: -91.2,
		})

		const restored = deserializeFST(serializeFST(m))
		const q = restored.query("Pierre")

		expect(q.accepting.map((p) => p.crossCountryBranches)).toEqual([7, 0])
	})
})
