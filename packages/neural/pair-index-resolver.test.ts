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
 * itself — `schemaVersion: 3` and the embedded tag table (see the tagTable describe block below).
 */
const HEADER_AS_WRITTEN: PairIndexHeader = { ...HEADER, schemaVersion: 3, tagTable: [...COMPONENT_TAGS] }

/**
 * Hand-build a PIX1 binary independent of `serializePairIndex`, so tests can express states the serializer refuses to
 * produce (legacy headers without `tagTable`, foreign tag tables, out-of-range indices, records missing the schema-3
 * parent byte) — and so the layout-conformance block below checks the serializer against the DOCUMENTED format
 * (docs/engineering/reference/pix1.ksy) rather than against itself.
 *
 * `records` are `[child, parent, tagIdx, parentTagIdx]`. Passing `parentTagIdx: undefined` writes the schema-2 record
 * shape (no trailing parent byte), which is how the v2-refusal test builds a genuine legacy binary.
 */
function buildRawIndex(
	headerObj: Record<string, unknown>,
	records: Array<[child: string, parent: string, tagIdx: number, parentTagIdx?: number]>
): Uint8Array {
	const enc = new TextEncoder()
	const headerBytes = enc.encode(JSON.stringify(headerObj))

	const encoded = records.map(([child, parent, tagIdx, parentTagIdx]) => ({
		child: enc.encode(child),
		parent: enc.encode(parent),
		tagIdx,
		parentTagIdx,
	}))

	let size = 12 + headerBytes.length

	for (const r of encoded) {
		size += 2 + r.child.length + 2 + r.parent.length + 1 + (r.parentTagIdx === undefined ? 0 : 1)
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

		if (r.parentTagIdx !== undefined) {
			out[o++] = r.parentTagIdx
		}
	}

	return out
}

const ENTRIES: PairIndexEntry[] = [
	{ child: "shoreditch", parent: "london", tag: "dependent_locality", parentTag: "locality" },
	{ child: "london", parent: "greater london", tag: "locality", parentTag: "region" },
	{ child: "camden", parent: "london", tag: "dependent_locality", parentTag: "locality" },
]

/**
 * The edge a probe hit returns for each of {@link ENTRIES} — the whole typed edge, not half of it (schema 3).
 */
const DEP_LOC_UNDER_LOCALITY = { tag: "dependent_locality", parentTag: "locality" }
const LOCALITY_UNDER_REGION = { tag: "locality", parentTag: "region" }

function resolver(entries: PairIndexEntry[] = ENTRIES, header: PairIndexHeaderInput = HEADER): PairIndexResolver {
	return new PairIndexResolver(serializePairIndex(header, entries))
}

describe("serializePairIndex / PairIndexResolver", () => {
	it("round-trips multiple entries: every (child, parent) probes to its whole typed edge", () => {
		const r = resolver()

		expect(r.probe("shoreditch", "london")).toEqual(DEP_LOC_UNDER_LOCALITY)
		expect(r.probe("london", "greater london")).toEqual(LOCALITY_UNDER_REGION)
		expect(r.probe("camden", "london")).toEqual(DEP_LOC_UNDER_LOCALITY)
	})

	it("returns undefined for an unknown (child, parent) pair", () => {
		expect(resolver().probe("shoreditch", "manchester")).toBeUndefined()
		expect(resolver().probe("nowhere", "london")).toBeUndefined()
	})

	it("distinguishes pairs sharing a child with different parents", () => {
		const r = resolver()

		// "london" is a child of "greater london" AND a parent of "shoreditch"/"camden" — the probe key
		// must be the full (child, parent) tuple, not just the child.
		expect(r.probe("london", "greater london")).toEqual(LOCALITY_UNDER_REGION)
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
		const bumped = { ...headerJSON, schemaVersion: 4 }
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
			{ child: "london", parent: "greater london", tag: "locality", parentTag: "region" },
			{ child: "london", parent: "greater london", tag: "locality", parentTag: "region" },
		]

		expect(() => serializePairIndex(HEADER, dupes)).toThrow(/duplicate/i)
	})

	it("is stable regardless of input order (sorted by child, parent bytes)", () => {
		const reversed = [...ENTRIES].toReversed()
		const a = new PairIndexResolver(serializePairIndex(HEADER, ENTRIES))
		const b = new PairIndexResolver(serializePairIndex(HEADER, reversed))

		expect(a.probe("shoreditch", "london")).toEqual(b.probe("shoreditch", "london"))
		expect(a.probe("camden", "london")).toEqual(b.probe("camden", "london"))
	})

	it("distinguishes pairs that would collide under naive concatenation", () => {
		// Both entries would produce "new york ny" under space-join of child + parent,
		// requiring the key to encode (child, parent) as a tuple, not a concatenation.
		const collisionEntries: PairIndexEntry[] = [
			{ child: "new york", parent: "ny", tag: "locality", parentTag: "region" },
			{ child: "new", parent: "york ny", tag: "locality", parentTag: "region" },
		]

		const r = resolver(collisionEntries)

		// Each (child, parent) pair must resolve to its own tag.
		expect(r.probe("new york", "ny")).toEqual(LOCALITY_UNDER_REGION)
		expect(r.probe("new", "york ny")).toEqual(LOCALITY_UNDER_REGION)

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

		expect(r.header).toEqual({ ...header, schemaVersion: 3, tagTable: [...COMPONENT_TAGS] })
		expect(r.transitionBeta).toBe(5)
		expect(peekPairIndexHeader(bytes).transitionBeta).toBe(5)
		// The rest of the format is untouched — entries still probe.
		expect(r.probe("shoreditch", "london")).toEqual(DEP_LOC_UNDER_LOCALITY)
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
		// transitionBeta stays absence-tolerant WITHIN a schema — optional fields ride on the JSON header without
		// version bumps; only the RECORD-shaping fields (the tag table, the parent byte) are version-gated.
		expect(r.header.schemaVersion).toBe(3)
	})
})

describe("parentDelta header field (whole-edge default-on, #46)", () => {
	it("round-trips a header WITH parentDelta: header fidelity + the resolver accessor + peek all agree", () => {
		const header: PairIndexHeaderInput = { ...HEADER, parentDelta: 5 }
		const bytes = serializePairIndex(header, ENTRIES)
		const r = new PairIndexResolver(bytes)

		expect(r.header).toEqual({ ...header, schemaVersion: 3, tagTable: [...COMPONENT_TAGS] })
		expect(r.parentDelta).toBe(5)
		expect(peekPairIndexHeader(bytes).parentDelta).toBe(5)
	})

	it("absence-tolerant: a header WITHOUT the field reads back parentDelta === undefined", () => {
		// Absent means "no parent bias", NOT "0" — the same absence contract transitionBeta carries, and the
		// one de/in/es/it artifacts ship under (unmeasured locales, per-locale gate).
		const bytes = serializePairIndex(HEADER, ENTRIES)
		const r = new PairIndexResolver(bytes)

		expect(r.parentDelta).toBeUndefined()
		expect(peekPairIndexHeader(bytes).parentDelta).toBeUndefined()
		expect("parentDelta" in r.header).toBe(false)
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
			parentTag: "locality" as const,
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

describe("tagTable header field (self-describing tag decode)", () => {
	const V3_BASE = { ...HEADER, schemaVersion: 3 }

	it("the serializer embeds the live COMPONENT_TAGS as the header's tagTable", () => {
		expect(peekPairIndexHeader(serializePairIndex(HEADER, ENTRIES)).tagTable).toEqual([...COMPONENT_TAGS])
	})

	it("decodes tagIdx through the EMBEDDED table, not COMPONENT_TAGS position", () => {
		// A table in reversed order: if the reader consulted COMPONENT_TAGS positionally, this index
		// would decode to whatever tag happens to mirror "locality" — the reordering bug the table
		// exists to kill.
		const reversed = [...COMPONENT_TAGS].toReversed()
		const idxOfLocality = reversed.indexOf("locality")
		const idxOfRegion = reversed.indexOf("region")

		const bytes = buildRawIndex({ ...V3_BASE, tagTable: reversed }, [
			["london", "greater london", idxOfLocality, idxOfRegion],
		])

		expect(new PairIndexResolver(bytes).probe("london", "greater london")).toEqual(LOCALITY_UNDER_REGION)
	})

	it("throws on a record whose tagTable entry is not a known ComponentTag, naming the tag", () => {
		const bytes = buildRawIndex({ ...V3_BASE, tagTable: ["definitely_not_a_tag", "locality"] }, [["a", "b", 0, 1]])

		expect(() => new PairIndexResolver(bytes)).toThrow(/definitely_not_a_tag/)
	})

	it("throws on a record whose PARENT tagTable entry is not a known ComponentTag, naming it", () => {
		const bytes = buildRawIndex({ ...V3_BASE, tagTable: ["locality", "definitely_not_a_parent_tag"] }, [
			["a", "b", 0, 1],
		])

		expect(() => new PairIndexResolver(bytes)).toThrow(/definitely_not_a_parent_tag/)
	})

	it("tolerates unknown tagTable entries that no record references (forward compatibility within v3)", () => {
		// A binary built where COMPONENT_TAGS has grown a tag this reader predates: loadable as long as
		// no record uses the unknown tag.
		const bytes = buildRawIndex({ ...V3_BASE, tagTable: ["dependent_locality", "locality", "some_future_tag"] }, [
			["a", "b", 0, 1],
		])

		expect(new PairIndexResolver(bytes).probe("a", "b")).toEqual(DEP_LOC_UNDER_LOCALITY)
	})

	it("throws on a tagIdx outside the embedded table", () => {
		const bytes = buildRawIndex({ ...V3_BASE, tagTable: ["locality"] }, [["a", "b", 7, 0]])

		expect(() => new PairIndexResolver(bytes)).toThrow(/tagIdx/)
	})

	it("throws on a parentTagIdx outside the embedded table", () => {
		const bytes = buildRawIndex({ ...V3_BASE, tagTable: ["locality"] }, [["a", "b", 0, 7]])

		expect(() => new PairIndexResolver(bytes)).toThrow(/parentTagIdx/)
	})
})

describe("parentTag record field (schemaVersion 3 — the typed parent)", () => {
	it("round-trips the parent tag independently of the child tag", () => {
		const r = resolver()

		// Same child tag, different parent tag — proves the parent byte is read per-record and not
		// derived from the child (the WESTERN_PARENT_OF containment derivation this schema replaces).
		expect(r.probe("shoreditch", "london")).toEqual({ tag: "dependent_locality", parentTag: "locality" })
		expect(r.probe("london", "greater london")).toEqual({ tag: "locality", parentTag: "region" })
	})

	it("carries a parent tag the containment map would NOT have derived", () => {
		// `WESTERN_PARENT_OF.dependent_locality` is `["locality"]`. The US borough source legitimately
		// emits a dependent_locality UNDER a borough (also dependent_locality) — a derived parent tag
		// could never say that; a recorded one can.
		const r = resolver([
			{ child: "park slope", parent: "brooklyn", tag: "dependent_locality", parentTag: "dependent_locality" },
		])

		expect(r.probe("park slope", "brooklyn")).toEqual({
			tag: "dependent_locality",
			parentTag: "dependent_locality",
		})
	})

	it("refuses an entry with no parentTag at all", () => {
		const entries = [{ child: "a", parent: "b", tag: "locality" }] as unknown as PairIndexEntry[]

		expect(() => serializePairIndex(HEADER, entries)).toThrow(/parentTag/)
	})

	it("refuses an entry whose parentTag is not a ComponentTag, naming it", () => {
		const entries = [
			{ child: "a", parent: "b", tag: "locality", parentTag: "not_a_tag" },
		] as unknown as PairIndexEntry[]

		expect(() => serializePairIndex(HEADER, entries)).toThrow(/not_a_tag/)
	})

	it("REFUSES a v2 binary (child tag only, no parent byte) with rebuild guidance", () => {
		// The v2 shape: a tagTable in the header, but records that stop after `tagIdx`. Reading those
		// bytes as v3 would swallow the NEXT record's child_len as a parent tag — refusing is the only
		// safe read, and the break is deliberate (operator-ruled 2026-08-04).
		const v2Header = { ...HEADER, schemaVersion: 2, tagTable: [...COMPONENT_TAGS] }
		const bytes = buildRawIndex(v2Header, [["london", "greater london", COMPONENT_TAGS.indexOf("locality")]])

		expect(() => new PairIndexResolver(bytes)).toThrow(/gazetteer pair-index/)
		expect(() => peekPairIndexHeader(bytes)).toThrow(/gazetteer pair-index/)
	})

	it("REFUSES a v1 binary (no tagTable, positional tags) with rebuild guidance", () => {
		// The v1 shape: schemaVersion 1, no tagTable, tagIdx positional into COMPONENT_TAGS.
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

		expect(header.schemaVersion).toBe(3)
		expect(Array.isArray(header.tagTable)).toBe(true)

		// pair_count: u4le
		let o = 8 + headerLen
		const pairCount = view.getUint32(o, true)
		o += 4
		expect(pairCount).toBe(ENTRIES.length)

		// pair records: u2le child_len, child, u2le parent_len, parent, u1 tag_idx, u1 parent_tag_idx —
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
			const parentTagIdx = bytes[o++]!

			expect(tagIdx).toBeLessThan(header.tagTable.length)
			expect(parentTagIdx).toBeLessThan(header.tagTable.length)
			expect(child > prevChild || (child === prevChild && parent > prevParent)).toBe(true)
			prevChild = child
			prevParent = parent
		}

		expect(o).toBe(bytes.length)
	})

	it("the parent byte costs exactly one byte per pair versus the schema-2 record shape", () => {
		// The format claim in prose ("+1 byte per pair") stated as an arithmetic identity over the
		// serializer's own output, so a future record-shape change cannot quietly falsify the model
		// cards' byte deltas.
		const bytes = serializePairIndex(HEADER, ENTRIES)
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		const headerLen = view.getUint32(4, true)
		const encoder = new TextEncoder()

		const recordBytes = ENTRIES.reduce(
			(sum, e) => sum + 2 + encoder.encode(e.child).length + 2 + encoder.encode(e.parent).length + 2,
			0
		)

		expect(bytes).toHaveLength(4 + 4 + headerLen + 4 + recordBytes)
	})
})
