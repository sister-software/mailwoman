/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Read side of the ancestrie. Zero-copy-ish: the tables stay in the source buffer and are read
 *   through a DataView on demand — only the token strings are decoded eagerly (a walk compares
 *   them), and payload bytes are returned as subarray views over the artifact. No Node imports
 *   anywhere on this path — the reader runs in the browser via
 *   `fetch(url).then((r) => r.arrayBuffer())` exactly as it runs on the server, the same discipline
 *   as `@mailwoman/neural`'s `pair-index-resolver.ts`.
 *
 *   One artifact answers three question families from the same walk:
 *
 *   - Lexical: `walk` / `walkFrom` / `continuations` — what continues this prefix.
 *   - Identity: `entriesAt` / `getEntry` — which ranked entries accept here.
 *   - Containment: `contains` (O(1) pre/post interval test, both directions), `descendantsOf`
 *       (contiguous range scan), `ancestorsOf` / `parentsOf` (chain hops). See `format.ts` for the
 *       interval encoding and the DAG-canonicalization rule.
 */

import type { AncestrieHeader, AncestrieSections } from "./format.ts"
import {
	computeSections,
	EDGE_ENTRY_SIZE,
	ENTRY_FLAG_HAS_PAYLOAD,
	ENTRY_FLAG_PAYLOAD_JSON,
	ENTRY_RECORD_SIZE,
	ENTRY_REF_SIZE,
	ID_INDEX_ENTRY_SIZE,
	readHeader,
	STATE_ENTRY_SIZE,
} from "./format.ts"
import type { AncestrieContinuation, AncestrieMatch, AncestrieRecord, JSONValue } from "./types.ts"

const UTF8_DECODER = new TextDecoder()

export class Ancestrie {
	private readonly bytes: Uint8Array
	private readonly view: DataView
	private readonly header: AncestrieHeader
	private readonly sections: AncestrieSections
	private readonly strings: string[]

	private constructor(
		bytes: Uint8Array,
		view: DataView,
		header: AncestrieHeader,
		sections: AncestrieSections,
		strings: string[]
	) {
		this.bytes = bytes
		this.view = view
		this.header = header
		this.sections = sections
		this.strings = strings
	}

	/**
	 * Open a sealed artifact. Validates magic, version, and that the buffer covers the layout the header declares; throws
	 * rather than reading past either.
	 */
	static from(data: Uint8Array): Ancestrie {
		const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
		const header = readHeader(view)
		const sections = computeSections(header)

		if (data.byteLength < sections.end) {
			throw new Error(`ancestrie buffer truncated: header declares ${sections.end} bytes, got ${data.byteLength}`)
		}

		const strings: string[] = new Array(header.stringCount)

		for (let i = 0; i < header.stringCount; i++) {
			const start = view.getUint32(sections.stringOffsets + i * 4, true)
			const end = view.getUint32(sections.stringOffsets + (i + 1) * 4, true)
			strings[i] = UTF8_DECODER.decode(data.subarray(sections.stringData + start, sections.stringData + end))
		}

		return new Ancestrie(data, view, header, sections, strings)
	}

	get stateCount(): number {
		return this.header.stateCount
	}

	get entryCount(): number {
		return this.header.entryCount
	}

	/**
	 * The metadata JSON stored at seal time, or `undefined` when the artifact carries none.
	 */
	metadata(): JSONValue | undefined {
		const offset = this.header.metadataOffset

		if (offset === 0 || offset >= this.view.byteLength) return undefined
		const length = this.view.getUint32(offset, true)

		// oxlint-disable-next-line no-restricted-properties -- zero-dependency leaf: reaching @mailwoman/core for parseJSONStrict would pull its ~11 MB of shipped data behind this browser-safe reader (the nuts-lookup precedent), and a throw on corrupt bytes IS this reader's contract.
		return JSON.parse(UTF8_DECODER.decode(this.bytes.subarray(offset + 4, offset + 4 + length))) as JSONValue
	}

	/**
	 * Walk a complete token sequence from the root. `null` when any token has no edge.
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
	 * The entries accepting at a state, highest rank first (the stored order — no query-time sort). `limit` caps how many
	 * are decoded; an out-of-range state yields `[]`.
	 */
	entriesAt(stateID: number, limit?: number): AncestrieRecord[] {
		if (stateID < 0 || stateID >= this.header.stateCount) return []
		const statePos = this.sections.stateTable + stateID * STATE_ENTRY_SIZE
		const refStart = this.view.getUint32(statePos + 8, true)
		const refCount = this.view.getUint32(statePos + 12, true)
		const count = limit === undefined ? refCount : Math.min(limit, refCount)
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
	 * Decode one entry by id, or `undefined` when the id names no entry.
	 */
	getEntry(id: number): AncestrieRecord | undefined {
		const ordinal = this.ordinalOf(id)

		if (ordinal < 0) return undefined

		return this.recordAt(ordinal)
	}

	/**
	 * The primary-parent lineage of an entry, nearest parent first. Every id resolves within the artifact except possibly
	 * the LAST: a declared-but-absent primary parent is included, then the chain stops (it cannot be walked further). An
	 * unknown `id` yields `[]`.
	 */
	ancestorsOf(id: number): number[] {
		const chain: number[] = []
		let ordinal = this.ordinalOf(id)

		if (ordinal < 0) return chain
		const seen = new Set<number>([id])

		while (true) {
			const recordPos = this.sections.entryTable + ordinal * ENTRY_RECORD_SIZE
			const parentCount = this.view.getUint16(recordPos + 20, true)

			if (parentCount === 0) break
			const parentStart = this.view.getUint32(recordPos + 16, true)
			const primary = this.view.getUint32(this.sections.parentTable + parentStart * 4, true)

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
	 * The full declared parent list of an entry, primary first — DAG edges, verbatim from the build. An unknown `id`
	 * yields `[]`.
	 */
	parentsOf(id: number): number[] {
		return this.getEntry(id)?.parentIDs ?? []
	}

	/**
	 * O(1) containment over the primary-parent forest: is `descendantID` inside `ancestorID`'s subtree? An entry contains
	 * itself. Secondary (non-primary) parent edges do NOT contribute — see the DAG-canonicalization rule in `format.ts`.
	 * Unknown ids answer `false`.
	 */
	contains(ancestorID: number, descendantID: number): boolean {
		const ancestorOrdinal = this.ordinalOf(ancestorID)
		const descendantOrdinal = this.ordinalOf(descendantID)

		if (ancestorOrdinal < 0 || descendantOrdinal < 0) return false
		const ancestorPos = this.sections.entryTable + ancestorOrdinal * ENTRY_RECORD_SIZE
		const descendantPos = this.sections.entryTable + descendantOrdinal * ENTRY_RECORD_SIZE

		return (
			this.view.getUint32(ancestorPos + 4, true) <= this.view.getUint32(descendantPos + 4, true) &&
			this.view.getUint32(descendantPos + 8, true) <= this.view.getUint32(ancestorPos + 8, true)
		)
	}

	/**
	 * Every proper descendant of an entry over the primary-parent forest, in pre-order. Entries are stored in forest
	 * pre-order, so this is a contiguous range scan of the entry table — the subtree size falls out of the interval
	 * labels as (post − pre − 1) / 2. Unknown ids yield `[]`.
	 */
	descendantsOf(id: number): number[] {
		const ordinal = this.ordinalOf(id)

		if (ordinal < 0) return []
		const recordPos = this.sections.entryTable + ordinal * ENTRY_RECORD_SIZE
		const pre = this.view.getUint32(recordPos + 4, true)
		const post = this.view.getUint32(recordPos + 8, true)
		const count = (post - pre - 1) / 2
		const ids: number[] = new Array(count)

		for (let i = 0; i < count; i++) {
			ids[i] = this.view.getUint32(this.sections.entryTable + (ordinal + 1 + i) * ENTRY_RECORD_SIZE, true)
		}

		return ids
	}

	/**
	 * Binary search the state's sorted edges for an exact token. Returns the target state, or −1.
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
	 * Binary search the id index. Returns the entry's ordinal, or −1.
	 */
	private ordinalOf(id: number): number {
		let lo = 0
		let hi = this.header.entryCount - 1

		while (lo <= hi) {
			const mid = (lo + hi) >>> 1
			const indexPos = this.sections.idIndex + mid * ID_INDEX_ENTRY_SIZE
			const candidate = this.view.getUint32(indexPos, true)

			if (candidate === id) return this.view.getUint32(indexPos + 4, true)

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
		const recordPos = this.sections.entryTable + ordinal * ENTRY_RECORD_SIZE
		const parentStart = this.view.getUint32(recordPos + 16, true)
		const parentCount = this.view.getUint16(recordPos + 20, true)
		const flags = this.view.getUint16(recordPos + 22, true)
		const parentIDs: number[] = new Array(parentCount)

		for (let i = 0; i < parentCount; i++) {
			parentIDs[i] = this.view.getUint32(this.sections.parentTable + (parentStart + i) * 4, true)
		}

		const record: AncestrieRecord = {
			id: this.view.getUint32(recordPos, true),
			rank: this.view.getFloat32(recordPos + 12, true),
			parentIDs,
		}

		if ((flags & ENTRY_FLAG_HAS_PAYLOAD) === ENTRY_FLAG_HAS_PAYLOAD) {
			const payloadStart = this.sections.payloadBlob + this.view.getUint32(recordPos + 24, true)
			const payloadLen = this.view.getUint32(recordPos + 28, true)
			const payloadBytes = this.bytes.subarray(payloadStart, payloadStart + payloadLen)

			record.payload =
				(flags & ENTRY_FLAG_PAYLOAD_JSON) === ENTRY_FLAG_PAYLOAD_JSON
					? // oxlint-disable-next-line no-restricted-properties -- zero-dependency leaf (see the metadata() note): core's JSON helpers cost ~11 MB of shipped data, and corrupt payload bytes should throw, not soft-fail.
						(JSON.parse(UTF8_DECODER.decode(payloadBytes)) as JSONValue)
					: payloadBytes
		}

		return record
	}
}
