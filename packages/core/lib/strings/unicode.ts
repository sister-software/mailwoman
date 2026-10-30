/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Character classes and splits over JavaScript's own Unicode properties: `\p{Nd}` for a decimal digit, `\p{L}` for
 *   a letter, and `\s` (WhiteSpace and LineTerminator) for whitespace, all at the running Node's Unicode version.
 */

const DECIMAL_DIGITS = /^\p{Nd}+$/u
const LETTER = /^\p{L}$/u
const WHITESPACE_CHARACTER = /^\s$/u
const WHITESPACE_RUN = /\s+/u
const LINE_BREAK = /\r\n|\n|\r/u

/**
 * Whether the text is non-empty and every character is a decimal digit (`\p{Nd}`), in any script.
 */
export function isDecimalDigits(value: string): boolean {
	return DECIMAL_DIGITS.test(value)
}

/**
 * Whether one character is a letter (`\p{L}`).
 */
export function isLetter(character: string): boolean {
	return LETTER.test(character)
}

/**
 * Whether one character is whitespace as `\s` defines it.
 */
export function isWhitespaceCharacter(character: string): boolean {
	return WHITESPACE_CHARACTER.test(character)
}

/**
 * The text split at each `\r\n`, `\n` or `\r`, with no empty entry after a final break.
 */
export function splitLines(text: string): string[] {
	const lines = text.split(LINE_BREAK)

	if (lines.at(-1) === "") {
		lines.pop()
	}

	return lines
}

/**
 * The runs between whitespace, with no empty entry.
 */
export function splitWhitespace(text: string): string[] {
	const trimmed = text.trim()

	return trimmed ? trimmed.split(WHITESPACE_RUN) : []
}

/**
 * The first character upper-cased and the rest lower-cased, by code point.
 */
export function capitalize(text: string): string {
	const [first, ...rest] = [...text]

	return first === undefined ? "" : first.toUpperCase() + rest.join("").toLowerCase()
}
