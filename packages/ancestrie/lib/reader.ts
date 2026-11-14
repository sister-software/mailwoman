// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Read side of the ancestrie.
 *
 *   Zero-copy-ish: the tables stay in the source buffer and are read through a DataView
 *   on demand — only the token strings are decoded eagerly (a walk compares them),
 *   and payload bytes are returned as subarray views over the artifact.
 *   No Node imports anywhere on this path — the reader runs in the browser via
 *   `fetch(url).then((r) => r.arrayBuffer())` exactly as it runs on the server,
 *   the same discipline as `@mailwoman/neural`'s `pair-index-resolver.ts`.
 *
 *   One artifact answers three question families from the same walk:
 *
 *   - Lexical: `walk` / `walkFrom` / `continuations` — what continues this prefix.
 *   - Identity: `entriesAt` / `getEntry` — which ranked entries accept here.
 *   - Containment: `contains` (O(1) pre/post interval test, both directions),
 *     `descendantsOf` (contiguous range scan), `ancestorsOf` / `parentsOf` (chain hops).
 *     See `format.ts` for the interval encoding and the DAG-canonicalization rule.
 */

import type { AncestrieHeader, AncestrieLayout, AncestrieSections } from "#format"
import {
	ancestrieLayout,
	computeSections,
	EDGE_ENTRY_SIZE,
	ENTRY_FLAG_HAS_PAYLOAD,
	ENTRY_FLAG_PAYLOAD_JSON,
	ENTRY_REF_SIZE,
	readHeader,
	readID,
	STATE_ENTRY_SIZE,
} from "#format"
import type { AncestrieContinuation, AncestrieMatch, AncestrieReaderLike, AncestrieRecord, JSONValue } from "#types"

const UTF8_DECODER = new TextDecoder()

export class Ancestrie implements AncestrieReaderLike {
	private readonly bytes: Uint8Array
	private readonly view: DataView
	private readonly header: AncestrieHeader
	private readonly sections: AncestrieSections
	private readonly layout: AncestrieLayout
	private readonly strings: string[]

	private constructor(
		bytes: Uint8Array,
		view: DataView,
		header: AncestrieHeader,
		sections: AncestrieSections,
		layout: AncestrieLayout,
		strings: string[]
	) {
		this.bytes = bytes
		this.view = view
		this.header = header
		this.sections = sections
		this.layout = layout
		this.strings = strings
	}

	/**
	 * The byte offset of the entry record at `ordinal`.
	 */
	private recordOffset(ordinal: number): number {
		return this.sections.entryTable + ordinal * this.layout.recordSize
	}

	/**
	 * Open a sealed artifact.
	 *
	 * Validates the magic and version.
	 * It also checks that the buffer covers the layout declared by the header.
	 * The reader throws when either check fails.
	 */
	static from(data: Uint8Array): Ancestrie {
		const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
		const header = readHeader(view)
		const layout = ancestrieLayout(header.version)
		const sections = computeSections(header, layout)

		if (data.byteLength < sections.end) {
			throw new Error(`ancestrie buffer truncated: header declares ${sections.end} bytes, got ${data.byteLength}`)
		}

		const strings: string[] = new Array(header.stringCount)

		for (let i = 0; i < header.stringCount; i++) {
			const start = view.getUint32(sections.stringOffsets + i * 4, true)
			const end = view.getUint32(sections.stringOffsets + (i + 1) * 4, true)
			strings[i] = UTF8_DECODER.decode(data.subarray(sections.stringData + start, sections.stringData + end))
		}

		return new Ancestrie(data, view, header, sections, layout, strings)
	}

	get stateCount(): number {
		return this.header.stateCount
	}

	get entryCount(): number {
		return this.header.entryCount
	}

	/**
	 * The metadata JSON stored at seal time, or `undefined` when the artifact has no metadata.
	 */
	metadata(): JSONValue | null {
		const offset = this.header.metadataOffset

		if (offset === 0 || offset >= this.view.byteLength) return null
		const length = this.view.getUint32(offset, true)

		// oxlint-disable-next-line no-restricted-properties -- zero-dependency leaf: reaching @mailwoman/core for parseJSONStrict would pull its ~11 MB of shipped data behind this browser-safe reader (the nuts-lookup precedent), and a throw on corrupt bytes is this reader's interface.
		return JSON.parse(UTF8_DECODER.decode(this.bytes.subarray(offset + 4, offset + 4 + length))) as JSONValue
	}

	/**
	 * Walk a complete token sequence from the root.
	 *
	 * `null` when any token has no edge.
	 */
	walk(tokens: readonly string[]): AncestrieMatch | null {
		let stateID = 0

		for (const token of tokens) {
			const next = this.findEdge(stateID, token)

			if (next < 0) return null
			stateID = next
		}

		return { stateID, accepted: this.entryRefCountOf(stateID) > 0, depth: tokens.length }
	}

	/**
	 * Advance a prior match by one token — the incremental-typing path.
	 */
	walkFrom(prev: AncestrieMatch, token: string): AncestrieMatch | null {
		const next = this.findEdge(prev.stateID, token)

		if (next < 0) return null

		return { stateID: next, accepted: this.entryRefCountOf(next) > 0, depth: prev.depth + 1 }
	}

	/**
	 * The entries accepting at a state, highest rank first (the stored order — no query-time sort).
	 *
	 * `limit` caps the number decoded.
	 * An out-of-range state yields `[]`.
	 */
	entriesAt(stateID: number, limit?: number): AncestrieRecord[] {
		if (stateID < 0 || stateID >= this.header.stateCount) return []
		const statePos = this.sections.stateTable + stateID * STATE_ENTRY_SIZE
		const refStart = this.view.getUint32(statePos + 8, true)
		const refCount = this.view.getUint32(statePos + 12, true)
		const count = typeof limit !== "number" ? refCount : Math.min(limit, refCount)
		const records: AncestrieRecord[] = new Array(count)

		for (let i = 0; i < count; i++) {
			const ordinal = this.view.getUint32(this.sections.entryRefTable + (refStart + i) * ENTRY_REF_SIZE, true)
			records[i] = this.recordAt(ordinal)
		}

		return records
	}

	/**
	 * The outgoing edges of a state, in token-sorted order.
	 */
	continuations(stateID: number): AncestrieContinuation[] {
		if (stateID < 0 || stateID >= this.header.stateCount) return []
		const statePos = this.sections.stateTable + stateID * STATE_ENTRY_SIZE
		const edgeStart = this.view.getUint32(statePos, true)
		const edgeCount = this.view.getUint32(statePos + 4, true)
		const result: AncestrieContinuation[] = new Array(edgeCount)

		for (let i = 0; i < edgeCount; i++) {
			const edgePos = this.sections.edgeTable + (edgeStart + i) * EDGE_ENTRY_SIZE
			const targetState = this.view.getUint32(edgePos + 4, true)

			result[i] = {
				token: this.strings[this.view.getUint32(edgePos, true)]!,
				targetState,
				entryCount: this.entryRefCountOf(targetState),
			}
		}

		return result
	}

	/**
	 * Decode one entry by id, or `undefined` when the id identifies no entry.
	 */
	getEntry(id: number): AncestrieRecord | null {
		const ordinal = this.ordinalOf(id)

		if (ordinal < 0) return null

		return this.recordAt(ordinal)
	}

	/**
	 * The primary-parent lineage of an entry, nearest parent first.
	 *
	 * Every id resolves within the artifact except possibly the last: a declared-but-absent
	 * primary parent is included, then the chain stops (it cannot be walked further).
	 * An unknown `id` yields `[]`.
	 */
	ancestorsOf(id: number): number[] {
		const chain: number[] = []
		let ordinal = this.ordinalOf(id)

		if (ordinal < 0) return chain
		const seen = new Set<number>([id])

		while (true) {
			const recordPos = this.recordOffset(ordinal)
			const parentCount = this.view.getUint16(recordPos + this.layout.parentCount, true)

			if (parentCount === 0) break
			const parentStart = this.view.getUint32(recordPos + this.layout.parentStart, true)
			const primary = readID(this.view, this.sections.parentTable + parentStart * this.layout.idBytes, this.layout)

			// A seal rejects primary-parent cycles, so this guard only trips on a corrupt artifact.
			if (seen.has(primary)) break
			chain.push(primary)
			seen.add(primary)
			ordinal = this.ordinalOf(primary)

			if (ordinal < 0) break
		}

		return chain
	}

	/**
	 * The full declared parent list of an entry, primary first — DAG edges, verbatim from the build.
	 *
	 * An unknown `id` yields `[]`.
	 */
	parentsOf(id: number): number[] {
		return this.getEntry(id)?.parentIDs ?? []
	}

	/**
	 * O(1) containment over the primary-parent forest: is `descendantID` inside `ancestorID`'s subtree?
	 *
	 * An entry contains itself.
	 * Secondary (non-primary) parent edges do not contribute.
	 * See the DAG-canonicalization rule in `format.ts`.
	 *
	 * Unknown ids answer `false`.
	 */
	contains(ancestorID: number, descendantID: number): boolean {
		const ancestorOrdinal = this.ordinalOf(ancestorID)
		const descendantOrdinal = this.ordinalOf(descendantID)

		if (ancestorOrdinal < 0 || descendantOrdinal < 0) return false
		const ancestorPos = this.recordOffset(ancestorOrdinal)
		const descendantPos = this.recordOffset(descendantOrdinal)
		const { pre, post } = this.layout

		return (
			this.view.getUint32(ancestorPos + pre, true) <= this.view.getUint32(descendantPos + pre, true) &&
			this.view.getUint32(descendantPos + post, true) <= this.view.getUint32(ancestorPos + post, true)
		)
	}

	/**
	 * Every proper descendant of an entry over the primary-parent forest, in pre-order.
	 *
	 * Entries are stored in forest pre-order, so this is a contiguous range scan of the entry
	 * table — the subtree size falls out of the interval labels as (post − pre − 1) / 2.
	 * Unknown ids yield `[]`.
	 */
	descendantsOf(id: number): number[] {
		const ordinal = this.ordinalOf(id)

		if (ordinal < 0) return []
		const recordPos = this.recordOffset(ordinal)
		const pre = this.view.getUint32(recordPos + this.layout.pre, true)
		const post = this.view.getUint32(recordPos + this.layout.post, true)
		const count = (post - pre - 1) / 2
		const ids: number[] = new Array(count)

		for (let i = 0; i < count; i++) {
			ids[i] = readID(this.view, this.recordOffset(ordinal + 1 + i), this.layout)
		}

		return ids
	}

	/**
	 * Binary search the state's sorted edges for an exact token.
	 *
	 * @returns the target state, or −1.
	 */
	private findEdge(stateID: number, token: string): number {
		if (stateID < 0 || stateID >= this.header.stateCount) return -1
		const statePos = this.sections.stateTable + stateID * STATE_ENTRY_SIZE
		const edgeStart = this.view.getUint32(statePos, true)
		const edgeCount = this.view.getUint32(statePos + 4, true)
		let lo = 0
		let hi = edgeCount - 1

		while (lo <= hi) {
			const mid = (lo + hi) >>> 1
			const edgePos = this.sections.edgeTable + (edgeStart + mid) * EDGE_ENTRY_SIZE
			const candidate = this.strings[this.view.getUint32(edgePos, true)]!

			if (candidate === token) return this.view.getUint32(edgePos + 4, true)

			if (candidate < token) {
				lo = mid + 1
			} else {
				hi = mid - 1
			}
		}

		return -1
	}

	/**
	 * Binary search the id index.
	 *
	 * @returns the entry's ordinal, or −1.
	 */
	private ordinalOf(id: number): number {
		let lo = 0
		let hi = this.header.entryCount - 1

		while (lo <= hi) {
			const mid = (lo + hi) >>> 1
			const indexPos = this.sections.idIndex + mid * this.layout.idIndexEntrySize
			const candidate = readID(this.view, indexPos, this.layout)

			if (candidate === id) return this.view.getUint32(indexPos + this.layout.idIndexOrdinal, true)

			if (candidate < id) {
				lo = mid + 1
			} else {
				hi = mid - 1
			}
		}

		return -1
	}

	private entryRefCountOf(stateID: number): number {
		return this.view.getUint32(this.sections.stateTable + stateID * STATE_ENTRY_SIZE + 12, true)
	}

	private recordAt(ordinal: number): AncestrieRecord {
		const layout = this.layout
		const recordPos = this.recordOffset(ordinal)
		const parentStart = this.view.getUint32(recordPos + layout.parentStart, true)
		const parentCount = this.view.getUint16(recordPos + layout.parentCount, true)
		const flags = this.view.getUint16(recordPos + layout.flags, true)
		const parentIDs: number[] = new Array(parentCount)

		for (let i = 0; i < parentCount; i++) {
			parentIDs[i] = readID(this.view, this.sections.parentTable + (parentStart + i) * layout.idBytes, layout)
		}

		const record: AncestrieRecord = {
			id: readID(this.view, recordPos, layout),
			rank: this.view.getFloat32(recordPos + layout.rank, true),
			parentIDs,
		}

		if ((flags & ENTRY_FLAG_HAS_PAYLOAD) === ENTRY_FLAG_HAS_PAYLOAD) {
			const payloadStart = this.sections.payloadBlob + this.view.getUint32(recordPos + layout.payloadStart, true)
			const payloadLen = this.view.getUint32(recordPos + layout.payloadLength, true)
			const payloadBytes = this.bytes.subarray(payloadStart, payloadStart + payloadLen)

			record.payload =
				(flags & ENTRY_FLAG_PAYLOAD_JSON) === ENTRY_FLAG_PAYLOAD_JSON
					? // oxlint-disable-next-line no-restricted-properties -- core's JSON helpers add ~11 MB to shipped data. This leaf parses directly, so corrupt payload bytes throw instead of soft-failing.
						(JSON.parse(UTF8_DECODER.decode(payloadBytes)) as JSONValue)
					: payloadBytes
		}

		return record
	}
}
