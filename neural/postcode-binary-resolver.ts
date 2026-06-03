/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Browser-side postcode resolver for the anchor (#240). A pure-JS, zero-dependency
 *   `PostcodeResolver` backed by a compact flat binary instead of SQLite, so the postcode anchor
 *   runs in the WASM/browser parser behind the same `lookup()` seam as the server-side
 *   `WofPostcodeLookup`.
 *
 *   This file owns BOTH ends of the format — `serializePostcodeBinary` (run in Node by
 *   `scripts/build-postcode-binary.ts`) and `PostcodeBinaryResolver` (run in the browser) — so the
 *   layout can never drift between writer and reader.
 *
 *   Binary layout (little-endian): magic "PCB1" (4 bytes) u32 recordCount u8 countryCount, then
 *   countryCount × 2 ASCII bytes (the country table) u8 keyWidth (max postcode length in bytes)
 *   records recordCount × { key[keyWidth] ASCII right-padded with 0x00, u8 countryIdx, i16 latQ,
 *   i16 lonQ }, sorted by key bytes ascending. A postcode present in two countries appears as two
 *   adjacent records (same key, different countryIdx).
 *
 *   Coordinates are quantized to i16: latQ = round(lat/90 × 32767), lonQ = round(lon/180 × 32767),
 *   giving ~300 m resolution — ample for a "which city/region" anchor. A record with latQ = lonQ =
 *   0 means "known postcode, no centroid" (membership only), matching the SQLite resolver's
 *   convention.
 */

import type { PostcodePlace } from "./postcode-anchor.js"

const MAGIC = 0x31_42_43_50 // "PCB1" little-endian (P=0x50 C=0x43 B=0x42 1=0x31)
const REC_TAIL = 5 // countryIdx(1) + latQ(2) + lonQ(2)
const LAT_Q = 32767 / 90
const LON_Q = 32767 / 180

export interface PostcodeBinaryEntry {
	postcode: string
	country: string
	lat: number
	lon: number
}

/**
 * Right-pad an ASCII postcode to `width` with NUL; `\0` sorts below any real char, so shorter keys
 * order before longer ones with the same prefix, which is what we want.
 */
function encodeKey(s: string, width: number, out: Uint8Array, offset: number): void {
	for (let i = 0; i < width; i++) out[offset + i] = i < s.length ? s.charCodeAt(i) & 0x7f : 0
}

/**
 * Serialize postcode entries into the flat binary. Entries are sorted by (postcode, country) so
 * equal postcodes land in adjacent records. Run in Node; consumed by
 * {@link PostcodeBinaryResolver}.
 */
export function serializePostcodeBinary(entries: readonly PostcodeBinaryEntry[]): Uint8Array {
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
	const countries = [...new Set(sorted.map((e) => e.country))].sort()
	const countryIdx = new Map(countries.map((c, i) => [c, i]))
	const keyWidth = sorted.reduce((m, e) => Math.max(m, e.postcode.length), 1)
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
		view.setInt16(o, Math.max(-32767, Math.min(32767, Math.round(e.lat * LAT_Q))), true)
		o += 2
		view.setInt16(o, Math.max(-32767, Math.min(32767, Math.round(e.lon * LON_Q))), true)
		o += 2
	}
	return buf
}

/**
 * Pure-JS, browser-safe postcode resolver over the flat binary. Implements the same `lookup()` seam
 * as the SQLite `WofPostcodeLookup`, so `extractPostcodeAnchors` is agnostic to which backs it.
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

	/** Compare the keyWidth bytes of record `i` against a padded query key. */
	#cmpKey(i: number, key: Uint8Array): number {
		const base = this.#recBase + i * this.#recSize
		for (let j = 0; j < this.#keyWidth; j++) {
			const d = this.#buf[base + j]! - key[j]!
			if (d !== 0) return d
		}
		return 0
	}

	lookup(postcode: string): PostcodePlace[] {
		if (postcode.length > this.#keyWidth) return [] // longer than any stored key → impossible
		const key = new Uint8Array(this.#keyWidth)
		encodeKey(postcode, this.#keyWidth, key, 0)

		// Binary search for the first record whose key >= the query.
		let lo = 0
		let hi = this.#count
		while (lo < hi) {
			const mid = (lo + hi) >>> 1
			if (this.#cmpKey(mid, key) < 0) lo = mid + 1
			else hi = mid
		}

		// Collect the contiguous run of equal keys (one per country).
		const out: PostcodePlace[] = []
		for (let i = lo; i < this.#count && this.#cmpKey(i, key) === 0; i++) {
			const base = this.#recBase + i * this.#recSize + this.#keyWidth
			out.push({
				country: this.#countries[this.#buf[base]!]!,
				lat: this.#view.getInt16(base + 1, true) / LAT_Q,
				lon: this.#view.getInt16(base + 3, true) / LON_Q,
			})
		}
		return out
	}
}
