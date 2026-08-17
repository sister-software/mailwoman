/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Serialization contract: round-trip fidelity, canonical byte-stability across add orders, header
 *   validation, payload/metadata encoding, and the empty/single-entry edges.
 */

import { describe, expect, it } from "vitest"

import { AncestrieBuilder } from "./builder.ts"
import { ANCESTRIE_FORMAT_VERSION } from "./format.ts"
import { Ancestrie } from "./reader.ts"
import type { AncestrieEntry } from "./types.ts"

const FIXTURE: AncestrieEntry[] = [
	{ tokens: ["united", "states"], id: 100, parentIDs: [], rank: 0.75, payload: { name: "United States" } },
	{ tokens: ["new", "york"], id: 10, parentIDs: [100], rank: 0.5 },
	{ tokens: ["new", "york"], id: 11, parentIDs: [10], rank: 0.875, payload: { name: "New York City" } },
	{ tokens: ["nyc"], id: 11, parentIDs: [10], rank: 0.875, payload: { name: "New York City" } },
	{ tokens: ["albany"], id: 12, parentIDs: [10], rank: 0.25, payload: new Uint8Array([1, 2, 3]) },
]

function sealFixture(entries: readonly AncestrieEntry[] = FIXTURE): Uint8Array {
	const builder = new AncestrieBuilder()

	for (const entry of entries) {
		builder.add(entry)
	}

	return builder.seal()
}

describe("serialize round-trip", () => {
	it("round-trips entries, ranks, parents, and payloads", () => {
		const trie = Ancestrie.from(sealFixture())

		expect(trie.entryCount).toBe(4)

		const us = trie.getEntry(100)!
		expect(us.id).toBe(100)
		expect(us.rank).toBe(0.75)
		expect(us.parentIDs).toEqual([])
		expect(us.payload).toEqual({ name: "United States" })

		const city = trie.getEntry(11)!
		expect(city.rank).toBe(0.875)
		expect(city.parentIDs).toEqual([10])
		expect(city.payload).toEqual({ name: "New York City" })

		// A bytes payload comes back verbatim as bytes, not JSON.
		const albany = trie.getEntry(12)!
		expect(albany.payload).toBeInstanceOf(Uint8Array)
		expect([...(albany.payload as Uint8Array)]).toEqual([1, 2, 3])

		// An absent payload stays absent — never an empty stand-in.
		expect(trie.getEntry(10)!.payload).toBeUndefined()
	})

	it("round-trips the trie shape: walks, aliases, continuations", () => {
		const trie = Ancestrie.from(sealFixture())

		expect(trie.walk(["new", "york"])).toMatchObject({ accepted: true, depth: 2 })
		expect(trie.walk(["nyc"])).toMatchObject({ accepted: true, depth: 1 })
		expect(trie.walk(["new"])).toMatchObject({ accepted: false, depth: 1 })
		expect(trie.walk(["missing"])).toBeNull()

		// Both same-surface entries accept at the "new york" state, highest rank first.
		const atNewYork = trie.entriesAt(trie.walk(["new", "york"])!.stateID)
		expect(atNewYork.map((r) => r.id)).toEqual([11, 10])

		const rootTokens = trie.continuations(0).map((c) => c.token)
		expect(rootTokens).toEqual(["albany", "new", "nyc", "united"])
	})

	it("walkFrom matches a fresh walk, one token at a time", () => {
		const trie = Ancestrie.from(sealFixture())
		const first = trie.walk(["new"])!
		const second = trie.walkFrom(first, "york")

		expect(second).toEqual(trie.walk(["new", "york"]))
		expect(trie.walkFrom(first, "zealand")).toBeNull()
	})

	it("is byte-stable across add orders (canonical output)", () => {
		const forward = sealFixture()
		const reversed = sealFixture(FIXTURE.toReversed())

		expect(forward).toEqual(reversed)
	})

	it("is byte-stable across repeated seals of one builder", () => {
		const builder = new AncestrieBuilder()

		for (const entry of FIXTURE) {
			builder.add(entry)
		}

		expect(builder.seal()).toEqual(builder.seal())
	})

	it("round-trips metadata, and reads undefined when none was sealed", () => {
		const builder = new AncestrieBuilder()
		builder.add(FIXTURE[0]!)

		const stamped = Ancestrie.from(builder.seal({ metadata: { source: "fixture", count: 1 } }))
		expect(stamped.metadata()).toEqual({ source: "fixture", count: 1 })

		const bare = Ancestrie.from(builder.seal())
		expect(bare.metadata()).toBeUndefined()
	})
})

describe("edge cases", () => {
	it("an empty build seals and reads: one root state, zero entries", () => {
		const trie = Ancestrie.from(new AncestrieBuilder().seal())

		expect(trie.stateCount).toBe(1)
		expect(trie.entryCount).toBe(0)
		expect(trie.walk([])).toMatchObject({ stateID: 0, accepted: false, depth: 0 })
		expect(trie.continuations(0)).toEqual([])
		expect(trie.getEntry(1)).toBeUndefined()
	})

	it("a single entry seals and answers every read", () => {
		const builder = new AncestrieBuilder()
		builder.add({ tokens: ["solo"], id: 7, parentIDs: [], rank: 0.5 })
		const trie = Ancestrie.from(builder.seal())

		expect(trie.entryCount).toBe(1)
		expect(trie.walk(["solo"])).toMatchObject({ accepted: true })
		expect(trie.getEntry(7)!.rank).toBe(0.5)
		expect(trie.ancestorsOf(7)).toEqual([])
		expect(trie.descendantsOf(7)).toEqual([])
		expect(trie.contains(7, 7)).toBe(true)
	})

	it("reads its artifact through a non-zero byteOffset view", () => {
		// A reader handed a subarray of a larger buffer (a file mmap, a network frame) must not
		// assume byteOffset 0.
		const bytes = sealFixture()
		const shifted = new Uint8Array(bytes.length + 6)
		shifted.set(bytes, 6)
		const trie = Ancestrie.from(shifted.subarray(6))

		expect(trie.entryCount).toBe(4)
		expect(trie.walk(["nyc"])).toMatchObject({ accepted: true })
	})
})

describe("validation", () => {
	it("rejects a magic mismatch", () => {
		const bytes = sealFixture()
		bytes[0] = 0x46

		expect(() => Ancestrie.from(bytes)).toThrow(/magic mismatch/)
	})

	it("rejects an unsupported version", () => {
		const bytes = sealFixture()
		const view = new DataView(bytes.buffer)
		view.setUint16(4, ANCESTRIE_FORMAT_VERSION + 1, true)

		expect(() => Ancestrie.from(bytes)).toThrow(/unsupported/)
	})

	it("rejects a truncated buffer", () => {
		const bytes = sealFixture()

		expect(() => Ancestrie.from(bytes.subarray(0, 40))).toThrow(/too small/)
		expect(() => Ancestrie.from(bytes.subarray(0, 60))).toThrow(/truncated/)
	})

	it("rejects an entry with no tokens, an empty token, or an out-of-range id", () => {
		const builder = new AncestrieBuilder()

		expect(() => builder.add({ tokens: [], id: 1, parentIDs: [], rank: 0 })).toThrow(/at least one token/)
		expect(() => builder.add({ tokens: [""], id: 1, parentIDs: [], rank: 0 })).toThrow(/empty token/)
		expect(() => builder.add({ tokens: ["x"], id: -1, parentIDs: [], rank: 0 })).toThrow(/integer/)
		expect(() => builder.add({ tokens: ["x"], id: 1.5, parentIDs: [], rank: 0 })).toThrow(/integer/)
		expect(() => builder.add({ tokens: ["x"], id: 1, parentIDs: [], rank: Number.NaN })).toThrow(/finite/)
	})

	it("accepts an alias re-add with identical metadata and rejects a diverging one", () => {
		const builder = new AncestrieBuilder()
		builder.add({ tokens: ["new", "york"], id: 1, parentIDs: [9], rank: 0.5 })

		expect(() => builder.add({ tokens: ["nyc"], id: 1, parentIDs: [9], rank: 0.5 })).not.toThrow()
		expect(() => builder.add({ tokens: ["big", "apple"], id: 1, parentIDs: [9], rank: 0.75 })).toThrow(/diverging/)
		expect(() => builder.add({ tokens: ["gotham"], id: 1, parentIDs: [8], rank: 0.5 })).toThrow(/diverging/)
	})
})
