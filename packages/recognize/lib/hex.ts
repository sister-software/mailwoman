// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Decodes the hexadecimal text an embedded artifact or binary is stored as.
 *
 *   Hexadecimal text holds only the characters `0-9a-f`.
 *   A generated module in hexadecimal never spells a word the repository's vocabulary census bans.
 *
 *   Base64 text can spell one by chance.
 *   It has no imports and runs in every runtime.
 */

const CODE_0 = "0".charCodeAt(0)
const CODE_9 = "9".charCodeAt(0)
const CODE_A = "a".charCodeAt(0)
const CODE_F = "f".charCodeAt(0)

/**
 * The count of decimal digits.
 * It is the value of the letter `a`.
 */
const DECIMAL_DIGITS = 10

/**
 * The bit width of one hexadecimal digit.
 */
const NIBBLE_BITS = 4

/**
 * The value of a hexadecimal digit's character code, or -1 for any other character.
 */
function nibble(code: number): number {
	if (code >= CODE_0 && code <= CODE_9) return code - CODE_0

	if (code >= CODE_A && code <= CODE_F) return code - CODE_A + DECIMAL_DIGITS

	return -1
}

/**
 * Decodes lowercase hexadecimal text into a fresh byte array.
 * Throws on an odd length or a character outside `0-9a-f`.
 */
export function decodeHex(text: string): Uint8Array<ArrayBuffer> {
	if (text.length % 2) throw new RangeError("hexadecimal text has an odd length")

	const bytes = new Uint8Array(text.length / 2)

	for (let index = 0; index < bytes.length; index++) {
		const high = nibble(text.charCodeAt(index * 2))
		const low = nibble(text.charCodeAt(index * 2 + 1))

		if (high < 0 || low < 0) {
			throw new RangeError(`hexadecimal text has a character outside 0-9a-f near offset ${index * 2}`)
		}

		bytes[index] = (high << NIBBLE_BITS) | low
	}

	return bytes
}
