/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A read-only map from strings to 32-bit integers, packed into typed arrays.
 *
 *   A `Map<string, number>` keeps one JavaScript string and one table entry per key. For a lexicon of a few hundred
 *   thousand place names that is tens of MiB of heap. This table keeps the keys' UTF-8 bytes in one buffer, their offsets
 *   and values beside them, and an open-addressing slot table, so the heap holds a handful of objects.
 *
 *   For the 392,653-entry locality-surface lexicon the four buffers take about 10 MiB, against about 18 MiB of heap for
 *   the `Map` and its key strings, measured in a workerd heap snapshot.
 */

import { hashFNV1a } from "@mailwoman/core/coarse-placer/fnv-hash"
import { stringifyJSON } from "@mailwoman/core/json"

const EMPTY_SLOT = -1

/**
 * The largest value a `Uint8Array` holds.
 *
 * A table whose values all lie in `0..BYTE_MAX` stores one byte per value.
 */
const BYTE_MAX = 255

/**
 * The first code unit past one-byte UTF-8 (U+0080) and past two-byte UTF-8 (U+0800).
 */
const TWO_BYTE_START = 0x80
const THREE_BYTE_START = 0x8_00

/**
 * The UTF-16 ranges of the leading (high) and trailing (low) halves of a surrogate pair.
 *
 * A leading half followed by a trailing half is one code point.
 * UTF-8 writes that code point in four bytes.
 */
const PAIR_LEAD_START = 0xd8_00
const PAIR_LEAD_END = 0xdb_ff
const PAIR_TRAIL_START = 0xdc_00
const PAIR_TRAIL_END = 0xdf_ff

/**
 * Returns the number of bytes `TextEncoder` writes for `text`.
 *
 * A lone surrogate encodes as U+FFFD, three bytes, as `TextEncoder` writes it.
 */
function utf8Length(text: string): number {
	let length = 0

	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index)

		if (code < TWO_BYTE_START) {
			length += 1
		} else if (code < THREE_BYTE_START) {
			length += 2
		} else if (code >= PAIR_LEAD_START && code <= PAIR_LEAD_END && index + 1 < text.length) {
			const next = text.charCodeAt(index + 1)

			if (next >= PAIR_TRAIL_START && next <= PAIR_TRAIL_END) {
				length += 4

				index++
			} else {
				length += 3
			}
		} else {
			length += 3
		}
	}

	return length
}

/**
 * Returns the smallest power of two that holds `count` keys at most three-quarters full.
 *
 * Linear probing at that load averages about 2.5 probes for a present key and 8.5 for an absent one.
 */
function slotCapacity(count: number): number {
	let capacity = 16

	while (capacity * 3 < count * 4) {
		capacity *= 2
	}

	return capacity
}

/**
 * A read-only string-to-integer map whose keys and values live in typed arrays.
 *
 * `get` and `has` answer as a `Map` built from the same entries would,
 * with a later duplicate key replacing an earlier one.
 * Values must be 32-bit signed integers.
 *
 * Keys compare by their UTF-8 encoding.
 * `TextEncoder` writes a lone surrogate as U+FFFD, so a key holding one can match a
 * different key that holds U+FFFD or another lone surrogate at the same position.
 */
export class PackedStringMap {
	readonly size: number
	readonly #bytes: Uint8Array
	readonly #offsets: Uint32Array
	readonly #values: Uint8Array | Int32Array
	readonly #slots: Int32Array
	readonly #encoder = new TextEncoder()
	#scratch = new Uint8Array(256)

	private constructor(keys: readonly string[], values: readonly number[]) {
		const offsets = new Uint32Array(keys.length + 1)

		for (let index = 0; index < keys.length; index++) {
			offsets[index + 1] = offsets[index]! + utf8Length(keys[index]!)
		}

		const bytes = new Uint8Array(offsets[keys.length]!)

		for (let index = 0; index < keys.length; index++) {
			this.#encoder.encodeInto(keys[index]!, bytes.subarray(offsets[index]!, offsets[index + 1]!))
		}

		for (let index = 0; index < keys.length; index++) {
			const value = values[index]!

			if (!Number.isInteger(value) || value < -(2 ** 31) || value >= 2 ** 31) {
				throw new RangeError(`PackedStringMap: the value for ${stringifyJSON(keys[index])} is not a 32-bit integer`)
			}
		}

		// The lexicons' slot bitmasks all fit in one byte.
		const fitsInByte = values.every((value) => value >= 0 && value <= BYTE_MAX)

		this.#bytes = bytes
		this.#offsets = offsets
		this.#values = fitsInByte ? Uint8Array.from(values) : Int32Array.from(values)
		this.#slots = new Int32Array(slotCapacity(keys.length)).fill(EMPTY_SLOT)

		let size = 0
		const mask = this.#slots.length - 1

		for (let index = 0; index < keys.length; index++) {
			let slot = hashFNV1a(keys[index]!) & mask

			for (;;) {
				const occupant = this.#slots[slot]!

				if (occupant === EMPTY_SLOT) {
					this.#slots[slot] = index

					size++

					break
				}

				if (this.#sameKey(occupant, bytes, offsets[index]!, offsets[index + 1]!)) {
					this.#slots[slot] = index

					break
				}

				slot = (slot + 1) & mask
			}
		}

		this.size = size
	}

	/**
	 * Builds a table from a parsed JSON object or from key-value pairs.
	 */
	static from(entries: Readonly<Record<string, number>> | Iterable<readonly [string, number]>): PackedStringMap {
		const keys: string[] = []
		const values: number[] = []
		const pairs = Symbol.iterator in entries ? entries : Object.entries(entries)

		for (const [key, value] of pairs as Iterable<readonly [string, number]>) {
			keys.push(key)
			values.push(value)
		}

		return new PackedStringMap(keys, values)
	}

	get(key: string): number | undefined {
		const index = this.#find(key)

		return index === EMPTY_SLOT ? undefined : this.#values[index]
	}

	has(key: string): boolean {
		return this.#find(key) !== EMPTY_SLOT
	}

	/**
	 * Returns the entry index holding `key`, or {@link EMPTY_SLOT}.
	 */
	#find(key: string): number {
		const needed = key.length * 3

		if (needed > this.#scratch.length) {
			this.#scratch = new Uint8Array(needed)
		}

		const { written } = this.#encoder.encodeInto(key, this.#scratch)
		const mask = this.#slots.length - 1
		let slot = hashFNV1a(key) & mask

		for (;;) {
			const occupant = this.#slots[slot]!

			if (occupant === EMPTY_SLOT) return EMPTY_SLOT

			if (this.#sameKey(occupant, this.#scratch, 0, written)) return occupant
			slot = (slot + 1) & mask
		}
	}

	/**
	 * Reports whether entry `index` holds the UTF-8 bytes `source[start..end)`.
	 */
	#sameKey(index: number, source: Uint8Array, start: number, end: number): boolean {
		const keyStart = this.#offsets[index]!
		const keyEnd = this.#offsets[index + 1]!

		if (keyEnd - keyStart !== end - start) return false

		for (let offset = 0; offset < end - start; offset++) {
			if (this.#bytes[keyStart + offset] !== source[start + offset]) return false
		}

		return true
	}
}
