/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Format v5 — the two-score split (ROAD_TO_V9 §2 R1). Round-trip, the meaning-of-zero rule on the
 *   encyclopedic channel, v4 back-compat, and the freshness guard's format verdict.
 */

import {
	fstStaleReason,
	FSTMatcher,
	type FSTNode,
	deserializeFST,
	FST_FORMAT_VERSION,
	serializeFST,
} from "@mailwoman/resolver-wof-sqlite/fst"
import { describe, expect, it } from "vitest"

/**
 * The v4 place-entry stride. Hard-coded rather than imported: the point of {@link downgradeToV4} is to write bytes the
 * current serializer no longer can.
 */
const V4_PLACE_ENTRY_SIZE = 56

/**
 * The v5 place-entry stride.
 */
const V5_PLACE_ENTRY_SIZE = 60

/**
 * A one-place matcher carrying `referential` and, optionally, `encyclopedic` — the Saint-Denis suburb's real numbers.
 */
function splitMatcher(encyclopedic?: number): FSTMatcher {
	const nodes: FSTNode[] = [
		{ edges: new Map([["saintdenis", 1]]), places: [] },
		{
			edges: new Map(),
			places: [
				{
					wofID: 101_751_155,
					placetype: "locality",
					name: "Saint-Denis",
					parentChain: [],
					referential: 0.4863,
					...(encyclopedic === undefined ? {} : { encyclopedic }),
					lat: 48.9296,
					lon: 2.3593,
				},
			],
		},
	]

	return FSTMatcher.fromNodes(nodes)
}

/**
 * Rewrite a v5 buffer's place table at the v4 stride (no encyclopedic float) and stamp the header back to 4 — the only
 * way to produce a genuine pre-split artifact now that the serializer writes v5.
 */
function downgradeToV4(v5: Buffer): Buffer {
	const headerSize = 32
	const stateEntrySize = 16
	const edgeEntrySize = 8
	const stateCount = v5.readUInt32LE(8)
	const edgeCount = v5.readUInt32LE(12)
	const placeCount = v5.readUInt32LE(16)
	const stringCount = v5.readUInt32LE(20)
	const stringBytes = v5.readUInt32LE(24)
	const stringTableSize = (stringCount + 1) * 4 + stringBytes
	const placeTableStart = headerSize + stringTableSize + stateCount * stateEntrySize + edgeCount * edgeEntrySize
	const out = Buffer.alloc(placeTableStart + placeCount * V4_PLACE_ENTRY_SIZE)
	v5.subarray(0, placeTableStart).copy(out, 0)

	for (let i = 0; i < placeCount; i++) {
		const from = placeTableStart + i * V5_PLACE_ENTRY_SIZE

		v5.subarray(from, from + V4_PLACE_ENTRY_SIZE).copy(out, placeTableStart + i * V4_PLACE_ENTRY_SIZE)
	}

	out.writeUInt16LE(4, 4)
	// This fixture carries no trailer; zero the offset so a reader reports no provenance.
	out.writeUInt32LE(0, 28)

	return out
}

describe("two-score split — format v5", () => {
	it("writes v5 and round-trips both scores", () => {
		const buf = serializeFST(splitMatcher(0.1173))

		expect(buf.readUInt16LE(4)).toBe(FST_FORMAT_VERSION)
		expect(FST_FORMAT_VERSION).toBe(5)

		const entry = deserializeFST(buf).query("Saint-Denis").accepting[0]!

		expect(entry.referential).toBeCloseTo(0.4863, 5)
		expect(entry.encyclopedic).toBeCloseTo(0.1173, 5)
	})

	it("an absent encyclopedic score round-trips as ABSENT, never as 0", () => {
		// The meaning-of-zero rule in bytes: roughly 89% of the gazetteer has no Wikipedia article, and
		// a consumer reading 0.0 there would be reading a fact nobody recorded.
		const entry = deserializeFST(serializeFST(splitMatcher())).query("Saint-Denis").accepting[0]!

		expect(entry.encyclopedic).toBeUndefined()
		expect("encyclopedic" in entry).toBe(false)
	})

	it("an encyclopedic score of exactly 0 survives as a RECORDED zero", () => {
		// The other half of the same rule — a place whose article scored 0 is not a place with no
		// article, and the per-place presence bit is what keeps them apart.
		const entry = deserializeFST(serializeFST(splitMatcher(0))).query("Saint-Denis").accepting[0]!

		expect(entry.encyclopedic).toBe(0)
	})

	it("a v4 artifact still reads, with its single float as referential and NO encyclopedic channel", () => {
		// Back-compat is real: the shipped fst-per-locale set is v4 and must keep loading. What it must
		// NOT do is invent an encyclopedic score — a v4 file has no such data and nowhere to put it.
		const entry = deserializeFST(downgradeToV4(serializeFST(splitMatcher(0.1173)))).query("Saint-Denis").accepting[0]!

		expect(entry.referential).toBeCloseTo(0.4863, 5)
		expect(entry.encyclopedic).toBeUndefined()
	})

	it("the freshness guard reports a v4 artifact as format-stale", () => {
		// §2 R1's stamp requirement (#1488 discipline): a pre-split binary's single float is
		// unattributable — population proxy or Wikipedia score, the bytes do not say — so it must not
		// read as current merely because its source md5 still matches.
		const stale = fstStaleReason(
			{ formatVersion: 4, provenance: undefined },
			{ source: { md5: "0".repeat(32), bytes: 1 } }
		)

		expect(stale).toBe(`format v4 → v${FST_FORMAT_VERSION}`)
	})
})
