// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The one place UTF-8 byte offsets become UTF-16 code-unit offsets.
 *
 *   The engine works in UTF-8 bytes, and every span the API returns is in UTF-16
 *   code units, the unit of `String.prototype.slice`.
 *   A span from the engine starts and ends on a codepoint boundary, and this module
 *   refuses an offset that isn't on one, so a span that split a codepoint raises an error
 *   instead of returning a wrong substring.
 *
 *   A lone surrogate encodes as U+FFFD, three bytes, as `TextEncoder` does, and counts as one code unit.
 */

/**
 * Maps byte offsets in the UTF-8 encoding of one text to code-unit offsets in the text.
 */
export interface OffsetMap {
	/**
	 * The code-unit offset of a byte offset.
	 *
	 * Throws a `RangeError` for an offset outside the text or inside a codepoint.
	 */
	toUTF16(byteOffset: number): number
}

function identity(length: number): OffsetMap {
	return {
		toUTF16(byteOffset) {
			if (!Number.isInteger(byteOffset) || byteOffset < 0 || byteOffset > length) {
				throw new RangeError(`byte offset ${byteOffset} is outside the text`)
			}

			return byteOffset
		},
	}
}

function isLowSurrogate(unit: number): boolean {
	return unit >= 0xdc_00 && unit <= 0xdf_ff
}

function isHighSurrogate(unit: number): boolean {
	return unit >= 0xd8_00 && unit <= 0xdb_ff
}

/**
 * The table every non-ASCII map reads, grown when a longer text needs it.
 *
 * A map built for one text is valid until the next call of {@link offsetMap}, because the next
 * map reuses the table, and allocating a typed array per call costs more than the pass that fills it.
 */
let scratch = new Int32Array(256)

/**
 * Builds the map for `text`, whose UTF-8 encoding is `byteLength` bytes.
 *
 * Text whose encoding is as long as the text itself is ASCII, because every other
 * codepoint takes more bytes than code units, and its offsets are equal.
 * The map for other text costs one pass over the text.
 *
 * The map is valid until the next call of this function.
 */
export function offsetMap(text: string, byteLength: number): OffsetMap {
	if (byteLength === text.length) return identity(byteLength)

	if (scratch.length < byteLength + 1) {
		scratch = new Int32Array(Math.max(byteLength + 1, scratch.length * 2))
	}

	const units = scratch

	units.fill(-1, 0, byteLength + 1)
	let byte = 0
	let unit = 0

	while (unit < text.length) {
		units[byte] = unit

		const code = text.charCodeAt(unit)

		if (code < 0x80) {
			byte += 1
			unit += 1
		} else if (code < 0x8_00) {
			byte += 2
			unit += 1
		} else if (isHighSurrogate(code) && unit + 1 < text.length && isLowSurrogate(text.charCodeAt(unit + 1))) {
			byte += 4
			unit += 2
		} else {
			byte += 3
			unit += 1
		}
	}

	if (byte !== byteLength) {
		throw new RangeError(`the text encodes to ${byte} bytes and the engine read ${byteLength}`)
	}

	units[byte] = text.length

	return {
		toUTF16(byteOffset) {
			const found =
				Number.isInteger(byteOffset) && byteOffset >= 0 && byteOffset <= byteLength ? units[byteOffset]! : -1

			if (found < 0) throw new RangeError(`byte offset ${byteOffset} is not on a codepoint boundary of the text`)

			return found
		},
	}
}
