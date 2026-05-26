/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { existsSync } from "node:fs"
import { beforeAll, describe, expect, it } from "vitest"
import { buildFstFromWof } from "./fst-builder.js"
import { FstMatcher, normalizeTokens, type FstNode } from "./fst-matcher.js"
import { deserializeFst, serializeFst } from "./fst-serialize.js"

// --- Unit tests with a synthetic trie ---

function buildSyntheticFst(): FstMatcher {
	const nodes: FstNode[] = [
		{ edges: new Map(), places: [] }, // root (0)
		{ edges: new Map(), places: [] }, // "new" (1)
		{
			edges: new Map(),
			places: [
				{
					wofId: 85977539,
					placetype: "locality",
					name: "New York City",
					parentChain: [85688543, 85633793],
					population: 8_804_000,
					lat: 40.7128,
					lon: -74.006,
				},
				{
					wofId: 85688543,
					placetype: "region",
					name: "New York",
					parentChain: [85633793],
					population: 20_200_000,
					lat: 42.1657,
					lon: -74.9481,
				},
			],
		}, // "york" (2)
		{
			edges: new Map(),
			places: [
				{
					wofId: 85688735,
					placetype: "locality",
					name: "Portland",
					parentChain: [85688513, 85633793],
					population: 665_000,
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

	return FstMatcher.fromNodes(nodes)
}

describe("FST binary serialization — unit (synthetic)", () => {
	const original = buildSyntheticFst()
	const buf = serializeFst(original)
	const restored = deserializeFst(buf)

	it("roundtrips state count", () => {
		expect(restored.stateCount).toBe(original.stateCount)
	})

	it("roundtrips place count", () => {
		expect(restored.placeCount).toBe(original.placeCount)
	})

	it("roundtrips 'New York' query", () => {
		const orig = original.query("New York")
		const rest = restored.query("New York")
		expect(rest.accepting.length).toBe(orig.accepting.length)
		expect(rest.accepting.map((p) => p.wofId).sort()).toEqual(orig.accepting.map((p) => p.wofId).sort())
	})

	it("roundtrips place entry fields exactly", () => {
		const orig = original.query("New York")
		const rest = restored.query("New York")
		const origNyc = orig.accepting.find((p) => p.placetype === "locality")!
		const restNyc = rest.accepting.find((p) => p.placetype === "locality")!
		expect(restNyc.wofId).toBe(origNyc.wofId)
		expect(restNyc.placetype).toBe(origNyc.placetype)
		expect(restNyc.name).toBe(origNyc.name)
		expect(restNyc.population).toBe(origNyc.population)
		expect(restNyc.parentChain).toEqual(origNyc.parentChain)
		expect(restNyc.lat).toBeCloseTo(origNyc.lat, 3)
		expect(restNyc.lon).toBeCloseTo(origNyc.lon, 3)
	})

	it("roundtrips 'Portland' query", () => {
		const orig = original.query("Portland")
		const rest = restored.query("Portland")
		expect(rest.accepting.length).toBe(orig.accepting.length)
		expect(rest.accepting[0]!.wofId).toBe(orig.accepting[0]!.wofId)
	})

	it("roundtrips continuations", () => {
		const orig = original.query("New")
		const rest = restored.query("New")
		expect(rest.continuations.map((c) => c.token).sort()).toEqual(orig.continuations.map((c) => c.token).sort())
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
	let original: FstMatcher
	let buf: Buffer
	let restored: FstMatcher

	beforeAll(() => {
		const { matcher } = buildFstFromWof({
			dbPath: WOF_DB,
			countries: ["US"],
			placetypes: ["country", "region", "county", "locality"],
			languages: ["eng", ""],
			onProgress: (phase, detail) => {
				if (phase === "done") console.log(`  ${phase}: ${detail}`)
			},
		})
		original = matcher
		buf = serializeFst(original)
		restored = deserializeFst(buf)
	}, 30_000)

	it("roundtrips state count", () => {
		expect(restored.stateCount).toBe(original.stateCount)
	})

	it("roundtrips place count", () => {
		expect(restored.placeCount).toBe(original.placeCount)
	})

	it("'New York' produces identical interpretations", () => {
		const orig = original.query("New York")
		const rest = restored.query("New York")
		expect(rest.accepting.length).toBe(orig.accepting.length)
		const origIds = orig.accepting.map((p) => p.wofId).sort()
		const restIds = rest.accepting.map((p) => p.wofId).sort()
		expect(restIds).toEqual(origIds)
	})

	it("NYC parent chain survives roundtrip", () => {
		const rest = restored.query("New York")
		const nyc = rest.accepting.find((p) => p.placetype === "locality" && p.population > 1_000_000)
		expect(nyc).toBeDefined()
		expect(nyc!.wofId).toBe(85977539)
		expect(nyc!.parentChain).toContain(85688543)
	})

	it("'Portland' produces identical localities", () => {
		const orig = original.query("Portland")
		const rest = restored.query("Portland")
		expect(rest.accepting.length).toBe(orig.accepting.length)
	})

	it("continuations match after roundtrip", () => {
		const orig = original.query("New")
		const rest = restored.query("New")
		const origTokens = orig.continuations.map((c) => c.token).sort()
		const restTokens = rest.continuations.map((c) => c.token).sort()
		expect(restTokens).toEqual(origTokens)
	})

	it("negative evidence for 'Buffalo Health Clinic' matches", () => {
		const orig = original.query("Buffalo Health Clinic")
		const rest = restored.query("Buffalo Health Clinic")
		expect(rest.path).toEqual(orig.path)
		expect(rest.accepting.length).toBe(orig.accepting.length)
	})

	it("binary size is reasonable", () => {
		const mb = buf.length / (1024 * 1024)
		console.log(`  FST binary: ${mb.toFixed(2)} MB (${buf.length} bytes)`)
		expect(mb).toBeLessThan(30)
		expect(mb).toBeGreaterThan(1)
	})
})
