/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"

/**
 * Reads little-endian values sequentially from a byte buffer, advancing `offset` after each read.
 *
 * A fixed-width read past the end throws the `DataView` `RangeError` that format readers
 * treat as truncation, but `bytes()` silently returns a shorter slice.
 */
export class ByteCursor {
	readonly #bytes: Uint8Array
	readonly #view: DataView
	offset: number

	constructor(bytes: Uint8Array, offset = 0) {
		this.#bytes = bytes
		this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		this.offset = offset
	}

	u8(): number {
		const value = this.#view.getUint8(this.offset)
		this.offset += 1

		return value
	}

	u16(): number {
		const value = this.#view.getUint16(this.offset, true)
		this.offset += 2

		return value
	}

	u32(): number {
		const value = this.#view.getUint32(this.offset, true)
		this.offset += 4

		return value
	}

	i16(): number {
		const value = this.#view.getInt16(this.offset, true)
		this.offset += 2

		return value
	}

	f32(): number {
		const value = this.#view.getFloat32(this.offset, true)
		this.offset += 4

		return value
	}

	f64(): number {
		const value = this.#view.getFloat64(this.offset, true)
		this.offset += 8

		return value
	}

	bytes(length: number): Uint8Array {
		const value = this.#bytes.subarray(this.offset, this.offset + length)
		this.offset += length

		return value
	}
}

/**
 * Serializes a binary frame header: the `u32` magic, the header length, and the header as UTF-8 JSON.
 *
 * Format serializers copy this frame to offset 0 and write their records after it.
 */
export function writeFramedHeader(magic: number, header: unknown): Uint8Array {
	const headerBytes = new TextEncoder().encode(stringifyJSON(header))
	const out = new Uint8Array(8 + headerBytes.length)
	const view = new DataView(out.buffer)

	view.setUint32(0, magic, true)
	view.setUint32(4, headerBytes.length, true)
	out.set(headerBytes, 8)

	return out
}

/**
 * Checks the magic and decodes the JSON header, returning it with a
 * {@link ByteCursor} at the first record byte.
 *
 * It throws `badMagicMessage` verbatim on a magic mismatch, because each format's tests pin its own wording.
 */
export function readFramedHeader<Header>(
	magic: number,
	bytes: Uint8Array,
	badMagicMessage: string
): { header: Header; cursor: ByteCursor } {
	const cursor = new ByteCursor(bytes)

	if (cursor.u32() !== magic) throw new Error(badMagicMessage)

	const headerLen = cursor.u32()
	const header = parseJSONStrict<Header>(new TextDecoder().decode(cursor.bytes(headerLen)))

	return { header, cursor }
}
