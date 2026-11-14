// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Tests format v5, the two-score split.
 *
 * They cover round-trip behavior and the meaning-of-zero rule.
 * They also cover v4 compatibility and the freshness guard's format verdict.
 */

import { describe, expect, it } from "vitest"

import { fstStaleReason, FSTMatcher, type FSTNode, deserializeFST, FST_FORMAT_VERSION, serializeFST } from "#fst"
import { idTableOffset, loadIDTable, placeEntryLayout } from "#fst/format"

/**
 * A one-place matcher carrying `referential` and, optionally, `encyclopedic`,
 * with the Saint-Denis suburb's real numbers.
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
					encyclopedic: encyclopedic ?? null,
					lat: 48.9296,
					lon: 2.3593,
					crossCountryBranches: null,
				},
			],
		},
	]

	return FSTMatcher.fromNodes(nodes)
}

/**
 * Rewrite a current-version buffer's place table in the v4 layout
 * (u32 ids, without the encyclopedic float) and stamp the header back to 4.
 *
 * That rewrite is the only way to produce a byte-accurate pre-split artifact now
 * that the serializer writes a later version.
 */
function downgradeToV4(current: Buffer): Buffer {
	const headerSize = 32
	const stateEntrySize = 16
	const edgeEntrySize = 8
	const from = placeEntryLayout(FST_FORMAT_VERSION)
	const to = placeEntryLayout(4)
	const stateCount = current.readUInt32LE(8)
	const edgeCount = current.readUInt32LE(12)
	const placeCount = current.readUInt32LE(16)
	const stringCount = current.readUInt32LE(20)
	const stringBytes = current.readUInt32LE(24)
	const stringTableSize = (stringCount + 1) * 4 + stringBytes
	const placeTableStart = headerSize + stringTableSize + stateCount * stateEntrySize + edgeCount * edgeEntrySize
	const out = Buffer.alloc(placeTableStart + placeCount * to.size)
	current.subarray(0, placeTableStart).copy(out, 0)

	const view = new DataView(current.buffer, current.byteOffset, current.byteLength)
	const ids = loadIDTable(view, idTableOffset(placeTableStart, placeCount, from), from)
	const id = (offset: number) => (ids ? ids[current.readUInt32LE(offset)]! : current.readUInt32LE(offset))

	for (let i = 0; i < placeCount; i++) {
		const source = placeTableStart + i * from.size
		const target = placeTableStart + i * to.size

		out.writeUInt32LE(id(source), target)

		for (const field of ["placetype", "chainLength", "crossCountryBranches", "flags"] as const) {
			out.writeUInt8(current.readUInt8(source + from[field]), target + to[field])
		}

		out.writeUInt32LE(current.readUInt32LE(source + from.name), target + to.name)

		for (const field of ["referential", "latitude", "longitude"] as const) {
			out.writeFloatLE(current.readFloatLE(source + from[field]), target + to[field])
		}

		for (let slot = 0; slot < 8; slot++) {
			out.writeUInt32LE(id(source + from.chain + slot * 4), target + to.chain + slot * 4)
		}
	}

	out.writeUInt16LE(4, 4)
	// Zero the offset so a reader reports no provenance.
	out.writeUInt32LE(0, 28)

	return out
}

describe("two-score split — format v5", () => {
	it("writes v5 and round-trips both scores", () => {
		const buf = serializeFST(splitMatcher(0.1173))

		expect(buf.readUInt16LE(4)).toBe(FST_FORMAT_VERSION)

		const entry = deserializeFST(buf).query("Saint-Denis").accepting[0]!

		expect(entry.referential).toBeCloseTo(0.4863, 5)
		expect(entry.encyclopedic).toBeCloseTo(0.1173, 5)
	})

	it("an absent encyclopedic score round-trips as null, never as 0", () => {
		// Roughly 89% of gazetteer places have no Wikipedia article.
		// A consumer reading 0.0 for those places would mistake absence for a recorded value.
		const entry = deserializeFST(serializeFST(splitMatcher())).query("Saint-Denis").accepting[0]!

		expect(entry.encyclopedic).toBeNull()
	})

	it("an encyclopedic score of exactly 0 survives as a RECORDED zero", () => {
		// A place with a score of 0 has a Wikipedia article.
		// The per-place presence bit distinguishes it from a place without an article.
		const entry = deserializeFST(serializeFST(splitMatcher(0))).query("Saint-Denis").accepting[0]!

		expect(entry.encyclopedic).toBe(0)
	})

	it("a v4 artifact still reads, with its single float as referential and NO encyclopedic channel", () => {
		// The shipped fst-per-locale set is v4 and must keep loading.
		// A v4 file has no encyclopedic data, so the reader reports the channel absent.
		const entry = deserializeFST(downgradeToV4(serializeFST(splitMatcher(0.1173)))).query("Saint-Denis").accepting[0]!

		expect(entry.referential).toBeCloseTo(0.4863, 5)
		expect(entry.encyclopedic).toBeNull()
	})

	it("the freshness guard reports a v4 artifact as format-stale", () => {
		// A pre-split binary's single float is unattributable, so it mustn't read as
		// current merely because its source md5 still matches.
		const stale = fstStaleReason({ formatVersion: 4, provenance: null }, { source: { md5: "0".repeat(32), bytes: 1 } })

		expect(stale).toBe(`format v4 → v${FST_FORMAT_VERSION}`)
	})
})
