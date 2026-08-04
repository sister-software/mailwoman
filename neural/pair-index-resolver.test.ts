/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Round-trip tests for the PIX1 placetype-pair index (#placetype-pair-prior arc):
 *   serialize a folded (child, parent) → tag table, load the bytes, and assert probe hits/misses,
 *   header fidelity, and the format's guard rails (bad magic, future schema, duplicate input,
 *   empty entries).
 */

import { parseJSONStrict } from "@mailwoman/core/objects"
import { COMPONENT_TAGS } from "@mailwoman/core/types"
import { describe, expect, it } from "vitest"

import {
	PairIndexResolver,
	peekPairIndexHeader,
	serializePairIndex,
	type PairIndexEntry,
	type PairIndexHeader,
	type PairIndexHeaderInput,
} from "./pair-index-resolver.ts"

const HEADER: PairIndexHeaderInput = {
	country: "gb",
	delta: 0.42,
	foldVersion: 1,
	sourceMD5s: ["abc123", "def456"],
	buildDate: "2026-07-22",
}

/**
 * What the serializer emits for {@link HEADER}: the input fields plus the two format-owned fields the serializer stamps
 * itself — `schemaVersion: 2` and the embedded tag table (see the tagTable describe block below).
 */
const HEADER_AS_WRITTEN: PairIndexHeader = { ...HEADER, schemaVersion: 2, tagTable: [...COMPONENT_TAGS] }

/**
 * Hand-build a PIX1 binary independent of `serializePairIndex`, so tests can express states the serializer refuses to
 * produce (legacy headers without `tagTable`, foreign tag tables, out-of-range indices) — and so the layout-conformance
 * block below checks the serializer against the DOCUMENTED format (docs/engineering/reference/pix1.ksy) rather than
 * against itself.
 */
function buildRawIndex(
	headerObj: Record<string, unknown>,
	records: Array<[child: string, parent: string, tagIdx: number]>
): Uint8Array {
	const enc = new TextEncoder()
	const headerBytes = enc.encode(JSON.stringify(headerObj))

	const encoded = records.map(([child, parent, tagIdx]) => ({
		child: enc.encode(child),
		parent: enc.encode(parent),
		tagIdx,
	}))

	let size = 12 + headerBytes.length

	for (const r of encoded) {
		size += 2 + r.child.length + 2 + r.parent.length + 1
	}

	const out = new Uint8Array(size)
	const view = new DataView(out.buffer)
	let o = 0

	view.setUint32(o, 0x31_58_49_50, true) // "PIX1" little-endian
	o += 4
	view.setUint32(o, headerBytes.length, true)
	o += 4
	out.set(headerBytes, o)
	o += headerBytes.length
	view.setUint32(o, encoded.length, true)
	o += 4

	for (const r of encoded) {
		view.setUint16(o, r.child.length, true)
		o += 2
		out.set(r.child, o)
		o += r.child.length
		view.setUint16(o, r.parent.length, true)
		o += 2
		out.set(r.parent, o)
		o += r.parent.length
		out[o++] = r.tagIdx
	}

	return out
}

const ENTRIES: PairIndexEntry[] = [
	{ child: "shoreditch", parent: "london", tag: "dependent_locality" },
	{ child: "london", parent: "greater london", tag: "locality" },
	{ child: "camden", parent: "london", tag: "dependent_locality" },
]

function resolver(entries: PairIndexEntry[] = ENTRIES, header: PairIndexHeaderInput = HEADER): PairIndexResolver {
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

	it("exposes the header as written (input fields + the embedded tag table), including delta", () => {
		const r = resolver()

		expect(r.header).toEqual(HEADER_AS_WRITTEN)
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
		const bytes = serializePairIndex(HEADER, ENTRIES)
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		const headerLen = view.getUint32(4, true)
		const headerJSON = parseJSONStrict<PairIndexHeader>(new TextDecoder().decode(bytes.subarray(8, 8 + headerLen)))

		// Rewrite the header JSON with a schemaVersion the reader doesn't know, re-serializing the whole
		// buffer so the length prefix stays correct.
		const bumped = { ...headerJSON, schemaVersion: 3 }
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
		expect(r.header).toEqual(HEADER_AS_WRITTEN)
	})

	it("rejects duplicate (child, parent) pairs at serialize time", () => {
		const dupes: PairIndexEntry[] = [
			{ child: "london", parent: "greater london", tag: "locality" },
			{ child: "london", parent: "greater london", tag: "locality" },
		]

		expect(() => serializePairIndex(HEADER, dupes)).toThrow(/duplicate/i)
	})

	it("is stable regardless of input order (sorted by child, parent bytes)", () => {
		const reversed = [...ENTRIES].toReversed()
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
		const header: PairIndexHeaderInput = { ...HEADER, transitionBeta: 5 }
		const bytes = serializePairIndex(header, ENTRIES)
		const r = new PairIndexResolver(bytes)

		expect(r.header).toEqual({ ...header, schemaVersion: 2, tagTable: [...COMPONENT_TAGS] })
		expect(r.transitionBeta).toBe(5)
		expect(peekPairIndexHeader(bytes).transitionBeta).toBe(5)
		// The rest of the format is untouched — entries still probe.
		expect(r.probe("shoreditch", "london")).toBe("dependent_locality")
	})

	it("old-binary compat: a header WITHOUT the field reads back transitionBeta === undefined", () => {
		// HEADER carries no transitionBeta, so the emitted header JSON has no such key at all (not
		// null/0) — the same absence an artifact built before the field existed carries. (Since the
		// tagTable build the serializer is no longer byte-identical to pre-field artifacts; the true
		// legacy-binary path is exercised with hand-built bytes in the tagTable describe block.)
		const bytes = serializePairIndex(HEADER, ENTRIES)
		const r = new PairIndexResolver(bytes)

		expect(r.transitionBeta).toBeUndefined()
		expect(peekPairIndexHeader(bytes).transitionBeta).toBeUndefined()
		expect("transitionBeta" in r.header).toBe(false)
		// transitionBeta stays absence-tolerant WITHIN v2 — optional fields ride on the JSON header without
		// version bumps; only the tag table (structural, decode-bearing) is version-gated.
		expect(r.header.schemaVersion).toBe(2)
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

		expect(peekPairIndexHeader(bytes)).toEqual(HEADER_AS_WRITTEN)
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

		expect(peekPairIndexHeader(truncated)).toEqual(HEADER_AS_WRITTEN)
		expect(() => new PairIndexResolver(truncated)).toThrow(/Offset is outside the bounds/)
	})
})

describe("tagTable header field (schemaVersion 2 — self-describing tag decode)", () => {
	const V2_BASE = { ...HEADER, schemaVersion: 2 }

	it("the serializer embeds the live COMPONENT_TAGS as the header's tagTable", () => {
		expect(peekPairIndexHeader(serializePairIndex(HEADER, ENTRIES)).tagTable).toEqual([...COMPONENT_TAGS])
	})

	it("decodes tagIdx through the EMBEDDED table, not COMPONENT_TAGS position", () => {
		// A table in reversed order: if the reader consulted COMPONENT_TAGS positionally, this index
		// would decode to whatever tag happens to mirror "locality" — the reordering bug the table
		// exists to kill.
		const reversed = [...COMPONENT_TAGS].toReversed()
		const idxOfLocality = reversed.indexOf("locality")
		const bytes = buildRawIndex({ ...V2_BASE, tagTable: reversed }, [["london", "greater london", idxOfLocality]])

		expect(new PairIndexResolver(bytes).probe("london", "greater london")).toBe("locality")
	})

	it("throws on a record whose tagTable entry is not a known ComponentTag, naming the tag", () => {
		const bytes = buildRawIndex({ ...V2_BASE, tagTable: ["definitely_not_a_tag"] }, [["a", "b", 0]])

		expect(() => new PairIndexResolver(bytes)).toThrow(/definitely_not_a_tag/)
	})

	it("tolerates unknown tagTable entries that no record references (forward compatibility within v2)", () => {
		// A binary built where COMPONENT_TAGS has grown a tag this reader predates: loadable as long as
		// no record uses the unknown tag.
		const bytes = buildRawIndex({ ...V2_BASE, tagTable: ["locality", "some_future_tag"] }, [["a", "b", 0]])

		expect(new PairIndexResolver(bytes).probe("a", "b")).toBe("locality")
	})

	it("throws on a tagIdx outside the embedded table", () => {
		const bytes = buildRawIndex({ ...V2_BASE, tagTable: ["locality"] }, [["a", "b", 7]])

		expect(() => new PairIndexResolver(bytes)).toThrow(/tagIdx/)
	})

	it("REFUSES a v1 binary (no tagTable, positional tags) with rebuild guidance", () => {
		// The v1 shape: schemaVersion 1, no tagTable, tagIdx positional into COMPONENT_TAGS. The break
		// is deliberate (2026-08-04, operator-approved): a positional fallback would keep the
		// tag-reordering trap alive for every artifact that never rebuilt.
		const v1Header = { ...HEADER, schemaVersion: 1 }
		const bytes = buildRawIndex(v1Header, [["london", "greater london", COMPONENT_TAGS.indexOf("locality")]])

		expect(() => new PairIndexResolver(bytes)).toThrow(/gazetteer pair-index/)
		expect(() => peekPairIndexHeader(bytes)).toThrow(/gazetteer pair-index/)
	})
})

describe("PIX1 layout conformance (docs/engineering/reference/pix1.ksy)", () => {
	it("serializer output walks byte-for-byte per the documented layout", () => {
		const bytes = serializePairIndex(HEADER, ENTRIES)
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		const decoder = new TextDecoder()

		// magic: the ASCII bytes "PIX1"
		expect(decoder.decode(bytes.subarray(0, 4))).toBe("PIX1")

		// header_len: u4le, then header_json: UTF-8 JSON of exactly that many bytes
		const headerLen = view.getUint32(4, true)
		const header = parseJSONStrict<PairIndexHeader>(decoder.decode(bytes.subarray(8, 8 + headerLen)))

		expect(header.schemaVersion).toBe(2)
		expect(Array.isArray(header.tagTable)).toBe(true)

		// pair_count: u4le
		let o = 8 + headerLen
		const pairCount = view.getUint32(o, true)
		o += 4
		expect(pairCount).toBe(ENTRIES.length)

		// pair records: u2le child_len, child, u2le parent_len, parent, u1 tag_idx —
		// sorted by (child, parent), consuming the buffer exactly.
		let prevChild = ""
		let prevParent = ""

		for (let i = 0; i < pairCount; i++) {
			const childLen = view.getUint16(o, true)
			o += 2
			const child = decoder.decode(bytes.subarray(o, o + childLen))
			o += childLen
			const parentLen = view.getUint16(o, true)
			o += 2
			const parent = decoder.decode(bytes.subarray(o, o + parentLen))
			o += parentLen
			const tagIdx = bytes[o++]!

			expect(tagIdx).toBeLessThan(header.tagTable.length)
			expect(child > prevChild || (child === prevChild && parent > prevParent)).toBe(true)
			prevChild = child
			prevParent = parent
		}

		expect(o).toBe(bytes.length)
	})
})
