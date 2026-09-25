/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { AnchorLookup } from "#anchor-inference"
import type { PostcodePlace } from "#postcode/anchor"

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
	}

	#cmpKey(i: number, key: Uint8Array): number {
		const base = this.#recBase + i * this.#recSize

		for (let j = 0; j < this.#keyWidth; j++) {
			const d = this.#buf[base + j]! - key[j]!

			if (d !== 0) return d
		}

		return 0
	}

	lookup(postcode: string): PostcodePlace[] {
		if (postcode.length > this.#keyWidth) return []
		const key = new Uint8Array(this.#keyWidth)
		encodeKey(postcode, this.#keyWidth, key, 0)

		let lo = 0
		let hi = this.#count

		while (lo < hi) {
			const mid = (lo + hi) >>> 1

			if (this.#cmpKey(mid, key) < 0) {
				lo = mid + 1
			} else {
				hi = mid
			}
		}

		const out: PostcodePlace[] = []

		for (let i = lo; i < this.#count && this.#cmpKey(i, key) === 0; i++) {
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
	 * Decodes the whole binary into an anchor lookup that maps each postcode to its
	 * member countries and the mean of its non-zero centroids.
	 *
	 * Each member country gets weight 1 rather than a normalized share,
	 * and a postcode with no non-zero centroid gets `0, 0`.
	 */
	toAnchorLookup(): AnchorLookup {
		const out: AnchorLookup = new Map()
		let i = 0

		while (i < this.#count) {
			const keyBase = this.#recBase + i * this.#recSize
			let postcode = ""

			for (let j = 0; j < this.#keyWidth; j++) {
				const c = this.#buf[keyBase + j]!

				if (c === 0) break
				postcode += String.fromCharCode(c)
			}

			const posterior: Record<string, number> = {}
			let latSum = 0
			let lonSum = 0
			let centroidCount = 0
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
				posterior[this.#countries[this.#buf[tail]!]!] = 1
				const lat = dequantizeCoordinate(this.#view.getInt16(tail + 1, true), LAT_Q)
				const lon = dequantizeCoordinate(this.#view.getInt16(tail + 3, true), LON_Q)

				if (lat !== 0 || lon !== 0) {
					latSum += lat
					lonSum += lon

					centroidCount++
				}
			}

			out.set(postcode, {
				posterior,
				lat: centroidCount ? latSum / centroidCount : 0,
				lon: centroidCount ? lonSum / centroidCount : 0,
			})

			i = k
		}

		return out
	}
}
