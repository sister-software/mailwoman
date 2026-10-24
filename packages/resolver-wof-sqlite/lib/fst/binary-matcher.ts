/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   An FST matcher that answers from the serialized binary in place.
 *
 *   {@link FSTMatcher} holds one `Map` per state and one object per place entry. For a national gazetteer those
 *   objects take several times the size of the file. This matcher keeps the file's bytes and two typed-array hash tables: one from
 *   an edge token to its string index, and one from a (state, string index) pair to the edge's target state. Place
 *   entries are decoded when a query reaches their state.
 */

import type { AncestrieMatch } from "@mailwoman/ancestrie"
import { hashFNV1a } from "@mailwoman/core/coarse-placer/fnv-hash"

import {
	EDGE_ENTRY_SIZE,
	ENCYCLOPEDIC_OFFSET,
	FST_FORMAT_VERSION,
	FST_MAGIC_BYTES,
	HEADER_SIZE,
	LEGACY_PLACE_ENTRY_SIZE,
	NARROW_STATE_ENTRY_SIZE,
	PLACE_FLAG_HAS_ENCYCLOPEDIC,
	PLACETYPE_ORDER,
	SPLIT_PLACE_ENTRY_SIZE,
	VERSION_TWO_SCORE_SPLIT,
	VERSION_WIDE_STATE_COUNTERS,
	WIDE_STATE_ENTRY_SIZE,
} from "#fst/format"
import { normalizeTokens } from "#fst/matcher"
import type { FSTContinuation, FSTQueryResult, PlaceEntry } from "#fst/types"

const EMPTY_SLOT = -1

/**
 * Returns the smallest power of two at least twice `count`, so each open-addressing
 * table stays at most half full.
 */
function tableCapacity(count: number): number {
	let capacity = 16

	while (capacity < count * 2) {
		capacity *= 2
	}

	return capacity
}

/**
 * Mixes a state and a string index into one 32-bit hash.
 */
function edgeHash(stateID: number, stringIndex: number): number {
	let h = Math.imul(stateID ^ 0x9e_37_79_b9, 0x85_eb_ca_6b) ^ Math.imul(stringIndex ^ 0xc2_b2_ae_35, 0x27_d4_eb_2f)

	h ^= h >>> 15

	return Math.imul(h, 0x2c_1b_3c_6d) >>> 0
}

/**
 * Reads an FST binary in the format `serializeFST` writes, versions 1 through
 * {@link FST_FORMAT_VERSION}, without decoding it into objects.
 */
export class BinaryFSTMatcher {
	readonly stateCount: number
	readonly #view: DataView
	readonly #bytes: Uint8Array
	readonly #decoder = new TextDecoder("utf-8")
	readonly #version: number
	readonly #isWide: boolean
	readonly #isSplit: boolean
	readonly #hasAmbiguity: boolean
	readonly #stateEntrySize: number
	readonly #placeEntrySize: number
	readonly #stringDataStart: number
	readonly #stateTableStart: number
	readonly #edgeTableStart: number
	readonly #placeTableStart: number
	readonly #stringOffsets: Uint32Array
	readonly #tokenSlots: Int32Array
	readonly #edgeSlotState: Int32Array
	readonly #edgeSlotString: Uint32Array
	readonly #edgeSlotTarget: Uint32Array
	#placeCount: number | null = null

	constructor(input: ArrayBuffer | Uint8Array) {
		const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

		if (bytes.byteLength < HEADER_SIZE) throw new Error("FST buffer too small for header")

		if (FST_MAGIC_BYTES.some((byte, index) => bytes[index] !== byte)) {
			throw new Error("FST magic mismatch")
		}

		const version = view.getUint16(4, true)

		if (version < 1 || version > FST_FORMAT_VERSION) {
			throw new Error(`FST version ${version} unsupported (expected 1..${FST_FORMAT_VERSION})`)
		}

		this.#bytes = bytes
		this.#view = view
		this.#version = version
		this.#isWide = version >= VERSION_WIDE_STATE_COUNTERS
		this.#isSplit = version >= VERSION_TWO_SCORE_SPLIT
		// Flags bit 0, as `serializeFST` writes it: place rows include surface-ambiguity data.
		this.#hasAmbiguity = (view.getUint16(6, true) & 1) === 1
		this.#stateEntrySize = this.#isWide ? WIDE_STATE_ENTRY_SIZE : NARROW_STATE_ENTRY_SIZE
		// Version 5 grew the place entry by the encyclopedic float.
		this.#placeEntrySize = this.#isSplit ? SPLIT_PLACE_ENTRY_SIZE : LEGACY_PLACE_ENTRY_SIZE

		const stateCount = view.getUint32(8, true)
		const edgeCount = view.getUint32(12, true)
		const stringCount = view.getUint32(20, true)
		const stringBytes = view.getUint32(24, true)

		this.stateCount = stateCount
		this.#stringOffsets = new Uint32Array(stringCount + 1)

		for (let index = 0; index <= stringCount; index++) {
			this.#stringOffsets[index] = view.getUint32(HEADER_SIZE + index * 4, true)
		}

		this.#stringDataStart = HEADER_SIZE + (stringCount + 1) * 4
		this.#stateTableStart = this.#stringDataStart + stringBytes
		this.#edgeTableStart = this.#stateTableStart + stateCount * this.#stateEntrySize
		this.#placeTableStart = this.#edgeTableStart + edgeCount * EDGE_ENTRY_SIZE

		this.#tokenSlots = new Int32Array(tableCapacity(stringCount)).fill(EMPTY_SLOT)

		const edgeCapacity = tableCapacity(edgeCount)

		this.#edgeSlotState = new Int32Array(edgeCapacity).fill(EMPTY_SLOT)
		this.#edgeSlotString = new Uint32Array(edgeCapacity)
		this.#edgeSlotTarget = new Uint32Array(edgeCapacity)

		const indexedTokens = new Uint8Array(stringCount)

		for (let stateID = 0; stateID < stateCount; stateID++) {
			const { edgeStart, edgeCount: stateEdgeCount } = this.#stateEntry(stateID)

			for (let edge = 0; edge < stateEdgeCount; edge++) {
				const entry = this.#edgeTableStart + (edgeStart + edge) * EDGE_ENTRY_SIZE
				const stringIndex = view.getUint32(entry, true)

				if (!indexedTokens[stringIndex]) {
					indexedTokens[stringIndex] = 1
					this.#indexToken(stringIndex)
				}

				this.#indexEdge(stateID, stringIndex, view.getUint32(entry + 4, true))
			}
		}
	}

	/**
	 * The number of place entries over all states.
	 */
	get placeCount(): number {
		if (this.#placeCount === null) {
			let count = 0

			for (let stateID = 0; stateID < this.stateCount; stateID++) {
				count += this.#stateEntry(stateID).placeCount
			}

			this.#placeCount = count
		}

		return this.#placeCount
	}

	get nodeCount(): number {
		return this.stateCount
	}

	walk(tokens: string[]): AncestrieMatch | null {
		let stateID = 0

		for (const token of tokens) {
			if (stateID >= this.stateCount) return null

			const next = this.#target(stateID, token)

			// No edge enters the root.
			// A target of 0 therefore marks a missing edge.
			if (!next) return null
			stateID = next
		}

		return { stateID, accepted: this.#stateEntry(stateID).placeCount > 0, depth: tokens.length }
	}

	walkFrom(prev: Pick<AncestrieMatch, "stateID" | "depth">, token: string): AncestrieMatch | null {
		if (prev.stateID >= this.stateCount) return null

		const next = this.#target(prev.stateID, token)

		if (!next) return null

		return { stateID: next, accepted: this.#stateEntry(next).placeCount > 0, depth: prev.depth + 1 }
	}

	accepting(stateID: number): PlaceEntry[] {
		if (stateID < 0 || stateID >= this.stateCount) return []

		const { placeStart, placeCount } = this.#stateEntry(stateID)
		const places: PlaceEntry[] = new Array(placeCount)

		for (let index = 0; index < placeCount; index++) {
			places[index] = this.#placeAt(placeStart + index)
		}

		return places
	}

	continuations(stateID: number): FSTContinuation[] {
		if (stateID < 0 || stateID >= this.stateCount) return []

		const { edgeStart, edgeCount } = this.#stateEntry(stateID)
		const result: FSTContinuation[] = []

		for (let edge = 0; edge < edgeCount; edge++) {
			const entry = this.#edgeTableStart + (edgeStart + edge) * EDGE_ENTRY_SIZE
			const targetState = this.#view.getUint32(entry + 4, true)

			result.push({
				token: this.#string(this.#view.getUint32(entry, true)),
				targetState,
				acceptingCount: this.#stateEntry(targetState).placeCount,
			})
		}

		return result
	}

	query(text: string): FSTQueryResult {
		const tokens = normalizeTokens(text)
		let stateID = 0
		let depth = 0

		for (const token of tokens) {
			const next = this.#target(stateID, token)

			if (!next) break
			stateID = next

			depth++
		}

		return {
			path: tokens.slice(0, depth),
			stateID,
			accepting: this.accepting(stateID),
			continuations: this.continuations(stateID),
		}
	}

	#stateEntry(stateID: number): { edgeStart: number; placeStart: number; edgeCount: number; placeCount: number } {
		const entry = this.#stateTableStart + stateID * this.#stateEntrySize
		const view = this.#view

		return {
			edgeStart: view.getUint32(entry, true),
			placeStart: view.getUint32(entry + 4, true),
			edgeCount: this.#isWide ? view.getUint32(entry + 8, true) : view.getUint16(entry + 8, true),
			placeCount: this.#isWide ? view.getUint32(entry + 12, true) : view.getUint16(entry + 10, true),
		}
	}

	#string(stringIndex: number): string {
		const start = this.#stringDataStart + this.#stringOffsets[stringIndex]!
		const end = this.#stringDataStart + this.#stringOffsets[stringIndex + 1]!

		return this.#decoder.decode(this.#bytes.subarray(start, end))
	}

	#indexToken(stringIndex: number): void {
		const mask = this.#tokenSlots.length - 1
		let slot = hashFNV1a(this.#string(stringIndex)) & mask

		while (this.#tokenSlots[slot] !== EMPTY_SLOT) {
			slot = (slot + 1) & mask
		}

		this.#tokenSlots[slot] = stringIndex
	}

	/**
	 * Returns the string index of `token` among the edge tokens, or -1 when no edge has that token.
	 */
	#tokenIndex(token: string): number {
		const mask = this.#tokenSlots.length - 1
		let slot = hashFNV1a(token) & mask

		for (;;) {
			const stringIndex = this.#tokenSlots[slot]!

			if (stringIndex === EMPTY_SLOT) return -1

			if (this.#string(stringIndex) === token) return stringIndex
			slot = (slot + 1) & mask
		}
	}

	#indexEdge(stateID: number, stringIndex: number, target: number): void {
		const mask = this.#edgeSlotState.length - 1
		let slot = edgeHash(stateID, stringIndex) & mask

		for (;;) {
			const occupant = this.#edgeSlotState[slot]!

			if (occupant === EMPTY_SLOT || (occupant === stateID && this.#edgeSlotString[slot] === stringIndex)) break
			slot = (slot + 1) & mask
		}

		// A repeated (state, token) pair keeps its last target, as `Map.set` does in the object deserializer.
		this.#edgeSlotState[slot] = stateID
		this.#edgeSlotString[slot] = stringIndex
		this.#edgeSlotTarget[slot] = target
	}

	/**
	 * Returns the state the edge labeled `token` leads to from `stateID`, or 0 when there is no such edge.
	 */
	#target(stateID: number, token: string): number {
		const stringIndex = this.#tokenIndex(token)

		if (stringIndex < 0) return 0

		const mask = this.#edgeSlotState.length - 1
		let slot = edgeHash(stateID, stringIndex) & mask

		for (;;) {
			const occupant = this.#edgeSlotState[slot]!

			if (occupant === EMPTY_SLOT) return 0

			if (occupant === stateID && this.#edgeSlotString[slot] === stringIndex) return this.#edgeSlotTarget[slot]!
			slot = (slot + 1) & mask
		}
	}

	#placeAt(placeIndex: number): PlaceEntry {
		const view = this.#view
		const entry = this.#placeTableStart + placeIndex * this.#placeEntrySize
		const chainLength = view.getUint8(entry + 5)
		const parentChain: number[] = new Array(chainLength)

		for (let index = 0; index < chainLength; index++) {
			parentChain[index] = view.getUint32(entry + 24 + index * 4, true)
		}

		// Version 1 stored a raw population u32 here, and later versions store the referential score.
		// `deserializeFST` explains why a version 1 value converts to the referential score this way.
		const referential =
			this.#version >= 2
				? view.getFloat32(entry + 12, true)
				: Math.min(1, Math.log2(1 + view.getUint32(entry + 12, true) / 1000) / 14)

		const hasEncyclopedic =
			this.#isSplit && (view.getUint8(entry + 7) & PLACE_FLAG_HAS_ENCYCLOPEDIC) === PLACE_FLAG_HAS_ENCYCLOPEDIC

		return {
			wofID: view.getUint32(entry, true),
			placetype: PLACETYPE_ORDER[view.getUint8(entry + 4)] ?? "locality",
			name: this.#string(view.getUint32(entry + 8, true)),
			referential,
			lat: view.getFloat32(entry + 16, true),
			lon: view.getFloat32(entry + 20, true),
			parentChain,
			crossCountryBranches: this.#hasAmbiguity ? view.getUint8(entry + 6) : null,
			encyclopedic: hasEncyclopedic ? view.getFloat32(entry + ENCYCLOPEDIC_OFFSET, true) : null,
		}
	}
}
