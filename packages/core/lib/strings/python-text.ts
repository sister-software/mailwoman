/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Python `str` predicates for ports whose output must match a Python tool's.
 */

/**
 * The characters CPython 3.12 (Unicode 15.0.0) counts as `str.isdigit()` outside
 * general category `Nd`: superscript, subscript, circled and parenthesized digits,
 * and the Ethiopic, Kharoshthi, Rumi and Brahmi digits whose numeric type is Digit.
 *
 * Listed from `c.isdigit() and unicodedata.category(c) != "Nd"` over every code point.
 */
const NON_DECIMAL_DIGITS =
	"²-³¹፩-፱᧚⁰⁴-⁹₀-₉①-⑨⑴-⑼⒈-⒐" +
	"⓪⓵-⓽⓿❶-❾➀-➈➊-➒\u{10A40}-\u{10A43}\u{10E60}-\u{10E68}" +
	"\u{11052}-\u{1105A}\u{1F100}-\u{1F10A}"

const PYTHON_DIGITS = new RegExp(`^[\\p{Nd}${NON_DECIMAL_DIGITS}]+$`, "u")

/**
 * Python `str.isdigit()`: non-empty, and every character a decimal digit or a digit of numeric type Digit.
 *
 * Node's `\p{Nd}` follows its own Unicode version, so a decimal digit a later
 * Unicode version added counts here and not in CPython 3.12.
 */
export function pythonIsDigit(value: string): boolean {
	return PYTHON_DIGITS.test(value)
}

/**
 * The characters Python's `str.isspace` admits, as a character class body.
 *
 * They are the characters of bidirectional class WS, B or S and of general category Zs.
 * `str.split()` and `str.strip()` split and strip on exactly these.
 */
const PYTHON_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000"
const ONE_SPACE = new RegExp(`^[${PYTHON_SPACE}]$`)
const SPACE_RUN = new RegExp(`[${PYTHON_SPACE}]+`)
const LEADING_SPACE = new RegExp(`^[${PYTHON_SPACE}]+`)
const TRAILING_SPACE = new RegExp(`[${PYTHON_SPACE}]+$`)

/**
 * Python `str.isspace()` for one character.
 */
export function pythonIsSpace(character: string): boolean {
	return ONE_SPACE.test(character)
}

/**
 * Python `str.rstrip()`.
 */
export function pythonRightStrip(text: string): string {
	return text.replace(TRAILING_SPACE, "")
}

/**
 * Python `str.strip()`.
 */
export function pythonStrip(text: string): string {
	return pythonRightStrip(text).replace(LEADING_SPACE, "")
}

/**
 * Python `str.split()` with no separator: the runs between whitespace, with no empty entry.
 */
export function pythonSplitWhitespace(text: string): string[] {
	const stripped = pythonStrip(text)

	return stripped ? stripped.split(SPACE_RUN) : []
}
