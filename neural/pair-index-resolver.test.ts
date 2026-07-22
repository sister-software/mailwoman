/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Round-trip tests for the PIX1 placetype-pair index (#placetype-pair-prior arc, Task 2):
 *   serialize a folded (child, parent) → tag table, load the bytes, and assert probe hits/misses,
 *   header fidelity, and the format's guard rails (bad magic, future schema, duplicate input,
 *   empty entries).
 */

import { describe, expect, it } from "vitest"

import {
	PairIndexResolver,
	serializePairIndex,
	type PairIndexEntry,
	type PairIndexHeader,
} from "./pair-index-resolver.ts"

const HEADER: PairIndexHeader = {
	country: "gb",
	delta: 0.42,
	schemaVersion: 1,
	foldVersion: 1,
	sourceMD5s: ["abc123", "def456"],
	buildDate: "2026-07-22",
}

const ENTRIES: PairIndexEntry[] = [
	{ child: "shoreditch", parent: "london", tag: "dependent_locality" },
	{ child: "london", parent: "greater london", tag: "locality" },
	{ child: "camden", parent: "london", tag: "dependent_locality" },
]

function resolver(entries: PairIndexEntry[] = ENTRIES, header: PairIndexHeader = HEADER): PairIndexResolver {
	return new PairIndexResolver(serializePairIndex(header, entries))
}

describe("serializePairIndex / PairIndexResolver", () => {
	it("round-trips multiple entries: every (child, parent) probes to its tag", () => {
		const r = resolver()

		expect(r.probe("shoreditch", "london")).toBe("dependent_locality")
		expect(r.probe("london", "greater london")).toBe("locality")
		expect(r.probe("camden", "london")).toBe("dependent_locality")
	})

	it("returns undefined for an unknown (child, parent) pair", () => {
		expect(resolver().probe("shoreditch", "manchester")).toBeUndefined()
		expect(resolver().probe("nowhere", "london")).toBeUndefined()
	})

	it("distinguishes pairs sharing a child with different parents", () => {
		const r = resolver()

		// "london" is a child of "greater london" AND a parent of "shoreditch"/"camden" — the probe key
		// must be the full (child, parent) tuple, not just the child.
		expect(r.probe("london", "greater london")).toBe("locality")
		expect(r.probe("shoreditch", "greater london")).toBeUndefined()
	})

	it("exposes the header verbatim, including delta", () => {
		const r = resolver()

		expect(r.header).toEqual(HEADER)
		expect(r.header.delta).toBe(0.42)
	})

	it("rejects a buffer with a bad magic", () => {
		expect(() => new PairIndexResolver(new Uint8Array(16))).toThrow(/bad magic/)
	})

	it("rejects a header claiming a schemaVersion newer than this reader knows", () => {
		const bytes = serializePairIndex({ ...HEADER, schemaVersion: 1 }, ENTRIES)
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		const headerLen = view.getUint32(4, true)
		const headerJSON = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLen))) as PairIndexHeader

		// Rewrite the header JSON with a schemaVersion the reader doesn't know, re-serializing the whole
		// buffer so the length prefix stays correct.
		const bumped = { ...headerJSON, schemaVersion: 2 }
		const bumpedBytes = new TextEncoder().encode(JSON.stringify(bumped))
		const rest = bytes.subarray(8 + headerLen)
		const out = new Uint8Array(4 + 4 + bumpedBytes.length + rest.length)
		const outView = new DataView(out.buffer)

		outView.setUint32(0, view.getUint32(0, true), true) // magic, unchanged
		outView.setUint32(4, bumpedBytes.length, true)
		out.set(bumpedBytes, 8)
		out.set(rest, 8 + bumpedBytes.length)

		expect(() => new PairIndexResolver(out)).toThrow(/schema/i)
	})

	it("handles an empty entry list as a valid file — every probe misses", () => {
		const r = resolver([])

		expect(r.probe("anything", "anything")).toBeUndefined()
		expect(r.header).toEqual(HEADER)
	})

	it("rejects duplicate (child, parent) pairs at serialize time", () => {
		const dupes: PairIndexEntry[] = [
			{ child: "london", parent: "greater london", tag: "locality" },
			{ child: "london", parent: "greater london", tag: "locality" },
		]

		expect(() => serializePairIndex(HEADER, dupes)).toThrow(/duplicate/i)
	})

	it("is stable regardless of input order (sorted by child, parent bytes)", () => {
		const reversed = [...ENTRIES].reverse()
		const a = new PairIndexResolver(serializePairIndex(HEADER, ENTRIES))
		const b = new PairIndexResolver(serializePairIndex(HEADER, reversed))

		expect(a.probe("shoreditch", "london")).toBe(b.probe("shoreditch", "london"))
		expect(a.probe("camden", "london")).toBe(b.probe("camden", "london"))
	})
})
