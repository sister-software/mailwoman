// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Key encodings: the position of a code in its direct-address key space, mirroring `crates/registry-core/src/key.rs`.
 *
 *   Two or three upper-case ASCII letters encode base-26 with the first letter in the highest place. A three-digit
 *   numeric code encodes as its decimal value. Every encoder checks length and alphabet first and answers `-1` for
 *   anything else. A caller normalizes case or whitespace before calling, never here.
 */

/**
 * The number of two-letter keys, 26².
 */
export const KEY_SPACE_2 = 676

/**
 * The number of three-letter keys, 26³.
 */
export const KEY_SPACE_3 = 17_576

/**
 * The number of three-digit numeric keys.
 */
export const KEY_SPACE_NUMERIC = 1000

/**
 * The arity value a section's `aux` field holds for a numeric key space.
 */
export const ARITY_NUMERIC = 0

/**
 * The value an encoder answers for a code outside its grammar.
 */
export const NO_KEY = -1

/**
 * The length of a two-letter code.
 */
export const CODE_LENGTH_2 = 2

/**
 * The length of a three-letter or three-digit code.
 */
export const CODE_LENGTH_3 = 3

const LETTERS = 26
const A = 65
const Z = 90
const ZERO = 48
const NINE = 57
const DECIMAL = 10

function isUpperLetter(charCode: number): boolean {
	return charCode >= A && charCode <= Z
}

/**
 * Encodes two upper-case ASCII letters, or answers {@link NO_KEY}.
 */
export function encode2(code: string): number {
	if (code.length !== CODE_LENGTH_2) return NO_KEY

	const a = code.charCodeAt(0)
	const b = code.charCodeAt(1)

	if (!isUpperLetter(a) || !isUpperLetter(b)) return NO_KEY

	return (a - A) * LETTERS + (b - A)
}

/**
 * Encodes three upper-case ASCII letters, or answers {@link NO_KEY}.
 */
export function encode3(code: string): number {
	if (code.length !== CODE_LENGTH_3) return NO_KEY

	const a = code.charCodeAt(0)
	const b = code.charCodeAt(1)
	const c = code.charCodeAt(2)

	if (!isUpperLetter(a) || !isUpperLetter(b) || !isUpperLetter(c)) return NO_KEY

	return ((a - A) * LETTERS + (b - A)) * LETTERS + (c - A)
}

/**
 * Encodes three ASCII digits, keeping a leading zero's position, or answers {@link NO_KEY}.
 */
export function encodeNumeric(code: string): number {
	if (code.length !== CODE_LENGTH_3) return NO_KEY

	let value = 0

	for (let index = 0; index < CODE_LENGTH_3; index++) {
		const digit = code.charCodeAt(index)

		if (digit < ZERO || digit > NINE) return NO_KEY

		value = value * DECIMAL + (digit - ZERO)
	}

	return value
}

/**
 * Encodes a code for the arity a section declares.
 */
export function encodeForArity(arity: number, code: string): number {
	switch (arity) {
		case ARITY_NUMERIC:
			return encodeNumeric(code)
		case CODE_LENGTH_2:
			return encode2(code)
		case CODE_LENGTH_3:
			return encode3(code)
		default:
			return NO_KEY
	}
}

/**
 * The three letters of a three-letter key.
 */
export function decode3(key: number): string {
	return String.fromCharCode(
		A + Math.floor(key / KEY_SPACE_2),
		A + (Math.floor(key / LETTERS) % LETTERS),
		A + (key % LETTERS)
	)
}

/**
 * The two letters of a two-letter key.
 */
export function decode2(key: number): string {
	return String.fromCharCode(A + Math.floor(key / LETTERS), A + (key % LETTERS))
}

/**
 * The three digits of a numeric key, with its leading zeroes.
 */
export function decodeNumeric(key: number): string {
	return String(key).padStart(CODE_LENGTH_3, "0")
}
