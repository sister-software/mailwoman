/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { PostcodePlace } from "@mailwoman/core/resolver"

/**
 * One postcode in a PCB1 binary with every place recorded for it.
 */
export interface PostcodeBinaryGroup {
	readonly postcode: string
	readonly places: readonly PostcodePlace[]
}

const MAGIC = 0x31_42_43_50

const REC_TAIL = 5

/**
 * Sets the latitude scale of the i16 coordinate grid (about 300 m resolution),
 * shared with the prefix index so both formats decode identically.
 */
export const LAT_Q = 32_767 / 90

/**
 * Sets the longitude scale of the i16 coordinate grid, the counterpart of {@link LAT_Q}.
 */
export const LON_Q = 32_767 / 180

/**
 * Quantizes a coordinate onto the i16 grid, clamping it so an out-of-range input cannot overflow the record.
 */
export function quantizeCoordinate(value: number, scale: number): number {
	return Math.max(-32_767, Math.min(32_767, Math.round(value * scale)))
}

/**
 * Decode a quantized i16 back to degrees.
 */
export function dequantizeCoordinate(quantized: number, scale: number): number {
	return quantized / scale
}

/**
 * Describes one postcode record passed to {@link serializePostcodeBinary},
 * with a two-letter country code and a representative point.
 */
export interface PostcodeBinaryEntry {
	postcode: string
	country: string
	lat: number
	lon: number
}

/**
 * The value of an empty hash slot.
 * A PCB1 binary holds fewer records than this.
 */
const EMPTY_SLOT = 0xff_ff_ff_ff

const FNV_OFFSET = 0x81_1c_9d_c5
const FNV_PRIME = 0x01_00_01_93

/**
 * FNV-1a over a postcode's characters as PCB1 encodes them (7-bit).
 */
function hashKey(postcode: string): number {
	let h = FNV_OFFSET

	for (let j = 0; j < postcode.length; j++) {
		h = Math.imul(h ^ (postcode.charCodeAt(j) & 0x7f), FNV_PRIME)
	}

	return h >>> 0
}

function encodeKey(s: string, width: number, out: Uint8Array, offset: number): void {
	for (let i = 0; i < width; i++) {
		out[offset + i] = i < s.length ? s.charCodeAt(i) & 0x7f : 0
	}
}

/**
 * Serializes postcode entries into the PCB1 binary read by {@link PostcodeBinaryResolver},
 * sorted by postcode and then country so matching postcodes are adjacent.
 */
export function serializePostcodeBinary(entries: readonly PostcodeBinaryEntry[]): Uint8Array {
	// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array. toSorted would double-allocate on a hot path
	const sorted = [...entries].sort((a, b) =>
		a.postcode < b.postcode
			? -1
			: a.postcode > b.postcode
				? 1
				: a.country < b.country
					? -1
					: a.country > b.country
						? 1
						: 0
	)

	// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array. toSorted would double-allocate on a hot path
	const countries = [...new Set(sorted.map((e) => e.country))].sort()
	const countryIdx = new Map(countries.map((c, i) => [c, i]))
	let keyWidth = 1

	for (const entry of sorted) {
		keyWidth = Math.max(keyWidth, entry.postcode.length)
	}

	const recSize = keyWidth + REC_TAIL

	const headerSize = 4 + 4 + 1 + countries.length * 2 + 1
	const buf = new Uint8Array(headerSize + sorted.length * recSize)
	const view = new DataView(buf.buffer)

	let o = 0
	view.setUint32(o, MAGIC, true)
	o += 4
	view.setUint32(o, sorted.length, true)
	o += 4
	buf[o++] = countries.length

	for (const c of countries) {
		buf[o++] = c.charCodeAt(0) & 0x7f
		buf[o++] = c.charCodeAt(1) & 0x7f
	}

	buf[o++] = keyWidth

	for (const e of sorted) {
		encodeKey(e.postcode, keyWidth, buf, o)
		o += keyWidth
		buf[o++] = countryIdx.get(e.country)!
		view.setInt16(o, quantizeCoordinate(e.lat, LAT_Q), true)
		o += 2
		view.setInt16(o, quantizeCoordinate(e.lon, LON_Q), true)
		o += 2
	}

	return buf
}

/**
 * Looks up postcodes by binary search over a PCB1 binary, in Node or the browser,
 * with the same `lookup()` interface as the SQLite `WOFPostcodeLookup`.
 */
export class PostcodeBinaryResolver {
	readonly #buf: Uint8Array
	readonly #view: DataView
	readonly #count: number
	readonly #countries: string[]
	readonly #keyWidth: number
	readonly #recSize: number
	readonly #recBase: number
	/**
	 * An open-addressing hash table over the records: each occupied slot holds the number
	 * of the first record of one postcode, and an empty slot holds {@link EMPTY_SLOT}.
	 *
	 * Records arrive in arbitrary order in a server, so a binary search pays a
	 * cache miss at most of its steps.
	 * One probe here reads one slot and one record.
	 *
	 * The table costs 4 bytes per slot at no more than half occupancy.
	 */
	readonly #slots: Uint32Array
	readonly #mask: number

	constructor(bytes: Uint8Array) {
		this.#buf = bytes
		this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

		if (this.#view.getUint32(0, true) !== MAGIC) throw new Error("postcode binary: bad magic")
		this.#count = this.#view.getUint32(4, true)
		let o = 8
		const countryCount = bytes[o++]!
		this.#countries = []

		for (let i = 0; i < countryCount; i++) {
			this.#countries.push(String.fromCharCode(bytes[o]!, bytes[o + 1]!))
			o += 2
		}

		this.#keyWidth = bytes[o++]!
		this.#recSize = this.#keyWidth + REC_TAIL
		this.#recBase = o

		let groups = 0

		for (let i = 0; i < this.#count; i++) {
			if (i === 0 || !this.#sameRecordKeys(i - 1, i)) {
				groups++
			}
		}

		let size = 1

		while (size < groups * 2) {
			size <<= 1
		}

		this.#mask = size - 1
		this.#slots = new Uint32Array(size).fill(EMPTY_SLOT)

		for (let i = 0; i < this.#count; i++) {
			if (i > 0 && this.#sameRecordKeys(i - 1, i)) continue
			let slot = this.#hashRecord(i) & this.#mask

			while (this.#slots[slot] !== EMPTY_SLOT) {
				slot = (slot + 1) & this.#mask
			}

			this.#slots[slot] = i
		}
	}

	#sameRecordKeys(a: number, b: number): boolean {
		const x = this.#recBase + a * this.#recSize
		const y = this.#recBase + b * this.#recSize

		for (let j = 0; j < this.#keyWidth; j++) {
			if (this.#buf[x + j] !== this.#buf[y + j]) return false
		}

		return true
	}

	/**
	 * FNV-1a over a record's key bytes up to its zero padding, equal to {@link hashKey} of the same postcode.
	 */
	#hashRecord(i: number): number {
		const base = this.#recBase + i * this.#recSize
		let h = FNV_OFFSET

		for (let j = 0; j < this.#keyWidth; j++) {
			const c = this.#buf[base + j]!

			if (c === 0) break
			h = Math.imul(h ^ c, FNV_PRIME)
		}

		return h >>> 0
	}

	#recordKeyIs(i: number, postcode: string): boolean {
		const base = this.#recBase + i * this.#recSize

		for (let j = 0; j < this.#keyWidth; j++) {
			const expected = j < postcode.length ? postcode.charCodeAt(j) & 0x7f : 0

			if (this.#buf[base + j] !== expected) return false
		}

		return true
	}

	lookup(postcode: string): PostcodePlace[] {
		if (postcode.length > this.#keyWidth) return []

		let slot = hashKey(postcode) & this.#mask
		let first = EMPTY_SLOT

		for (;;) {
			const record = this.#slots[slot]!

			if (record === EMPTY_SLOT) return []

			if (this.#recordKeyIs(record, postcode)) {
				first = record

				break
			}

			slot = (slot + 1) & this.#mask
		}

		const out: PostcodePlace[] = []

		for (let i = first; i < this.#count && (i === first || this.#sameRecordKeys(first, i)); i++) {
			const base = this.#recBase + i * this.#recSize + this.#keyWidth

			out.push({
				country: this.#countries[this.#buf[base]!]!,
				lat: dequantizeCoordinate(this.#view.getInt16(base + 1, true), LAT_Q),
				lon: dequantizeCoordinate(this.#view.getInt16(base + 3, true), LON_Q),
			})
		}

		return out
	}

	/**
	 * Yields every postcode in key order with the places recorded for it, one group per postcode.
	 */
	*groups(): Generator<PostcodeBinaryGroup> {
		let i = 0

		while (i < this.#count) {
			const keyBase = this.#recBase + i * this.#recSize
			let postcode = ""

			for (let j = 0; j < this.#keyWidth; j++) {
				const c = this.#buf[keyBase + j]!

				if (c === 0) break
				postcode += String.fromCharCode(c)
			}

			const places: PostcodePlace[] = []
			let k = i

			for (; k < this.#count; k++) {
				const base = this.#recBase + k * this.#recSize
				let same = true

				for (let j = 0; j < this.#keyWidth; j++) {
					if (this.#buf[base + j] !== this.#buf[keyBase + j]) {
						same = false

						break
					}
				}

				if (!same) break
				const tail = base + this.#keyWidth

				places.push({
					country: this.#countries[this.#buf[tail]!]!,
					lat: dequantizeCoordinate(this.#view.getInt16(tail + 1, true), LAT_Q),
					lon: dequantizeCoordinate(this.#view.getInt16(tail + 3, true), LON_Q),
				})
			}

			yield { postcode, places }

			i = k
		}
	}
}
