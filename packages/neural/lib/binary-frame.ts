/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The shared frame of the PCN1/PIX1/PFX1 binary family (little-endian): a u32 magic, a u32
 *   headerLen, then headerLen bytes of UTF-8-encoded JSON. Each format's records follow the frame
 *   and stay with their owning module — the single-file writer+reader discipline is per format; this
 *   module only keeps the three from restating the frame itself. Pure JS, no Node imports: the
 *   browser runtime loads the same artifacts.
 */

import { parseJSONStrict } from "@mailwoman/core/json"

/**
 * Sequential little-endian reader over a byte buffer. Reads advance `offset`; an out-of-bounds fixed-width read throws
 * the `DataView` `RangeError`, which is the truncation signal the format readers rely on.
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
 * Serialize the frame: magic, headerLen, and the header as UTF-8 JSON. A format's serializer sizes its buffer as
 * `frame.length + <record bytes>` and copies the frame in at offset 0, so the emitted bytes are identical to the
 * hand-rolled writes this replaces.
 */
export function writeFramedHeader(magic: number, header: unknown): Uint8Array {
	const headerBytes = new TextEncoder().encode(JSON.stringify(header))
	const out = new Uint8Array(8 + headerBytes.length)
	const view = new DataView(out.buffer)

	view.setUint32(0, magic, true)
	view.setUint32(4, headerBytes.length, true)
	out.set(headerBytes, 8)

	return out
}

/**
 * Validate the magic and decode the header JSON, returning the header plus a {@link ByteCursor} positioned at the first
 * record byte. `badMagicMessage` is the format's own wording — each reader's message is an error contract its tests
 * pin.
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
