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
