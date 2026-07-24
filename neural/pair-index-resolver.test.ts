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
	peekPairIndexHeader,
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

	it("exposes delta as a top-level accessor so the resolver conforms to PairIndexLike", () => {
		const r = resolver()

		expect(r.delta).toBe(0.42)
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

	it("distinguishes pairs that would collide under naive concatenation", () => {
		// Both entries would produce "new york ny" under space-join of child + parent,
		// requiring the key to encode (child, parent) as a tuple, not a concatenation.
		const collisionEntries: PairIndexEntry[] = [
			{ child: "new york", parent: "ny", tag: "locality" },
			{ child: "new", parent: "york ny", tag: "locality" },
		]

		const r = resolver(collisionEntries)

		// Each (child, parent) pair must resolve to its own tag.
		expect(r.probe("new york", "ny")).toBe("locality")
		expect(r.probe("new", "york ny")).toBe("locality")

		// Cross probes and malformed probes must miss.
		expect(r.probe("new york ny", "")).toBeUndefined()
		expect(r.probe("new york", "york ny")).toBeUndefined()
		expect(r.probe("new", "ny")).toBeUndefined()
	})
})

describe("transitionBeta header field (TRANSITION-BETA build)", () => {
	it("round-trips a header WITH transitionBeta: header fidelity + the resolver accessor + peek all agree", () => {
		const header: PairIndexHeader = { ...HEADER, transitionBeta: 5 }
		const bytes = serializePairIndex(header, ENTRIES)
		const r = new PairIndexResolver(bytes)

		expect(r.header).toEqual(header)
		expect(r.transitionBeta).toBe(5)
		expect(peekPairIndexHeader(bytes).transitionBeta).toBe(5)
		// The rest of the format is untouched — entries still probe.
		expect(r.probe("shoreditch", "london")).toBe("dependent_locality")
	})

	it("old-binary compat: a header WITHOUT the field reads back transitionBeta === undefined", () => {
		// HEADER carries no transitionBeta — serializing it produces byte-for-byte the same header JSON an
		// artifact built before this field existed carries (no key at all, not null/0), so this IS the
		// old-binary case, not a simulation of it.
		const bytes = serializePairIndex(HEADER, ENTRIES)
		const r = new PairIndexResolver(bytes)

		expect(r.transitionBeta).toBeUndefined()
		expect(peekPairIndexHeader(bytes).transitionBeta).toBeUndefined()
		expect("transitionBeta" in r.header).toBe(false)
		// schemaVersion stays 1 — absence-tolerant readers need no version gate (forward + backward compatible).
		expect(r.header.schemaVersion).toBe(1)
	})
})

describe("peekPairIndexHeader", () => {
	it("returns the header verbatim without building the probe Map (correctness, not timing)", () => {
		// A synthetic index large enough that a full parse would be a real cost (10k entries) — peek must
		// still return the exact header the constructor would, having touched none of the entry bytes.
		const bigEntries: PairIndexEntry[] = Array.from({ length: 10_000 }, (_, i) => ({
			child: `child-${i}`,
			parent: `parent-${i % 50}`,
			tag: "dependent_locality" as const,
		}))
		const bytes = serializePairIndex(HEADER, bigEntries)

		expect(peekPairIndexHeader(bytes)).toEqual(HEADER)
		// Cross-check against the constructor's own header parse — peek and full-parse must never disagree.
		expect(peekPairIndexHeader(bytes)).toEqual(new PairIndexResolver(bytes).header)
	})

	it("rejects a buffer with a bad magic, same as the constructor", () => {
		expect(() => peekPairIndexHeader(new Uint8Array(16))).toThrow(/bad magic/)
	})

	it("succeeds on a header-only-valid buffer whose entry section is truncated — the constructor throws on the same bytes", () => {
		// Serialize a normal index, then truncate everything after the header + pairCount fields — the
		// header block itself is untouched and fully valid, but the entry bytes it declares (pairCount > 0)
		// don't exist. This is the gate's real-world shape: a caller that peeks BEFORE constructing must
		// never pay for (or trip over) a full parse when it's about to discard the result on a country
		// mismatch.
		const bytes = serializePairIndex(HEADER, ENTRIES)
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		const headerLen = view.getUint32(4, true)
		const pairCountOffset = 4 + 4 + headerLen
		// Keep magic + headerLen + header JSON + the pairCount u32 itself, drop every entry record byte.
		const truncated = bytes.subarray(0, pairCountOffset + 4)

		expect(peekPairIndexHeader(truncated)).toEqual(HEADER)
		expect(() => new PairIndexResolver(truncated)).toThrow()
	})
})
