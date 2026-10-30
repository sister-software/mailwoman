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

/**
 * The decimal digits Unicode 15.1 to 17.0 assigned: general category `Nd` in Node's tables
 * and not `str.isdecimal()` in CPython 3.12.
 *
 * Listed by comparing `/^\p{Nd}$/u` under Node's Unicode 17.0 with `c.isdecimal()` under
 * CPython 3.12.3 (`unicodedata.unidata_version` 15.0.0) over every code point.
 * No code point is decimal in CPython and not in Node.
 */
const POST_UNICODE_15_DECIMALS =
	"\u{10D40}-\u{10D49}\u{116D0}-\u{116E3}\u{11BF0}-\u{11BF9}\u{11DE0}-\u{11DE9}" +
	"\u{16130}-\u{16139}\u{16D70}-\u{16D79}\u{1CCF0}-\u{1CCF9}\u{1E5F1}-\u{1E5FA}"

/**
 * One character Python's `\d` matches in a `str` pattern, a decimal digit of Unicode 15.0,
 * as a pattern for a `u` or `v` regular expression.
 */
export const PYTHON_DECIMAL = `(?:(?![${POST_UNICODE_15_DECIMALS}])\\p{Nd})`

const PYTHON_DIGITS = new RegExp(`^(?:${PYTHON_DECIMAL}|[${NON_DECIMAL_DIGITS}])+$`, "u")

/**
 * Python `str.isdigit()`: non-empty, and every character a decimal digit or a digit of
 * numeric type Digit, both as CPython 3.12's Unicode 15.0 tables assign them.
 */
export function pythonIsDigit(value: string): boolean {
	return PYTHON_DIGITS.test(value)
}

/**
 * The letters Unicode 15.1 to 17.0 assigned: general category `L` in Node's tables and not
 * `str.isalpha()` in CPython 3.12, 9,568 code points in 45 ranges, among them CJK Extensions I and J.
 *
 * Listed by comparing `/^\p{L}$/u` under Node's Unicode 17.0 with `c.isalpha()` under
 * CPython 3.12.3 (`unicodedata.unidata_version` 15.0.0) over every code point.
 * No code point is a letter in CPython and not in Node.
 */
const POST_UNICODE_15_LETTERS =
	"࢏౜೜Ᲊ-ᲊꟋ-꟏꟒꟔Ꟛ-Ƛ꟱" +
	"\u{105C0}-\u{105F3}\u{10940}-\u{10959}\u{10D4A}-\u{10D65}\u{10D6F}-\u{10D85}\u{10EC2}-\u{10EC7}" +
	"\u{11380}-\u{11389}\u{1138B}\u{1138E}\u{11390}-\u{113B5}\u{113B7}\u{113D1}\u{113D3}" +
	"\u{11BC0}-\u{11BE0}\u{11DB0}-\u{11DDB}\u{13460}-\u{143FA}\u{16100}-\u{1611D}\u{16D40}-\u{16D6C}" +
	"\u{16EA0}-\u{16EB8}\u{16EBB}-\u{16ED3}\u{16FF2}-\u{16FF3}\u{187F8}-\u{187FF}\u{18CFF}" +
	"\u{18D09}-\u{18D1E}\u{18D80}-\u{18DF2}\u{1E5D0}-\u{1E5ED}\u{1E5F0}\u{1E6C0}-\u{1E6DE}" +
	"\u{1E6E0}-\u{1E6E2}\u{1E6E4}-\u{1E6E5}\u{1E6E7}-\u{1E6ED}\u{1E6F0}-\u{1E6F4}\u{1E6FE}-\u{1E6FF}" +
	"\u{2B73A}-\u{2B73F}\u{2CEA2}-\u{2CEAD}\u{2EBF0}-\u{2EE5D}\u{323B0}-\u{33479}"

const PYTHON_LETTER = new RegExp(`^(?![${POST_UNICODE_15_LETTERS}])\\p{L}$`, "u")

/**
 * Python `str.isalpha()` for one character, as CPython 3.12's Unicode 15.0 tables assign letters.
 */
export function pythonIsAlphaCharacter(character: string): boolean {
	return PYTHON_LETTER.test(character)
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
 * The single characters besides `\r\n` that Python's `str.splitlines` splits on, as a character class body.
 */
const PYTHON_LINE_BREAK_CHARACTERS = "\\n\\r\\v\\f\\x1c-\\x1e\\x85\\u2028\\u2029"

/**
 * The line breaks Python's `str.splitlines` splits on.
 */
const PYTHON_LINE_BREAK = new RegExp(`\\r\\n|[${PYTHON_LINE_BREAK_CHARACTERS}]`)

/**
 * Python's `str.splitlines()`: the text split at each line break, with no empty entry after a final break.
 */
export function pythonSplitLines(text: string): string[] {
	const lines = text.split(PYTHON_LINE_BREAK)

	if (lines.at(-1) === "") {
		lines.pop()
	}

	return lines
}

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
 * Every character whose title case in CPython 3.12.3 differs from its upper case, then its title case.
 *
 * Listed from `c.title() != c.upper()` over every code point, one entry per `|`.
 * The first code point of an entry is the character and the rest is its title case.
 */
const TITLE_CASE_EXCEPTIONS =
	"\u{DF}\u{53}\u{73}|\u{1C4}\u{1C5}|\u{1C5}\u{1C5}|\u{1C6}\u{1C5}|\u{1C7}\u{1C8}|\u{1C8}\u{1C8}|\u{1C9}\u{1C8}|" +
	"\u{1CA}\u{1CB}|\u{1CB}\u{1CB}|\u{1CC}\u{1CB}|\u{1F1}\u{1F2}|\u{1F2}\u{1F2}|\u{1F3}\u{1F2}|\u{587}\u{535}\u{582}|" +
	"\u{10D0}\u{10D0}|\u{10D1}\u{10D1}|\u{10D2}\u{10D2}|\u{10D3}\u{10D3}|\u{10D4}\u{10D4}|\u{10D5}\u{10D5}|" +
	"\u{10D6}\u{10D6}|\u{10D7}\u{10D7}|\u{10D8}\u{10D8}|\u{10D9}\u{10D9}|\u{10DA}\u{10DA}|\u{10DB}\u{10DB}|" +
	"\u{10DC}\u{10DC}|\u{10DD}\u{10DD}|\u{10DE}\u{10DE}|\u{10DF}\u{10DF}|\u{10E0}\u{10E0}|\u{10E1}\u{10E1}|" +
	"\u{10E2}\u{10E2}|\u{10E3}\u{10E3}|\u{10E4}\u{10E4}|\u{10E5}\u{10E5}|\u{10E6}\u{10E6}|\u{10E7}\u{10E7}|" +
	"\u{10E8}\u{10E8}|\u{10E9}\u{10E9}|\u{10EA}\u{10EA}|\u{10EB}\u{10EB}|\u{10EC}\u{10EC}|\u{10ED}\u{10ED}|" +
	"\u{10EE}\u{10EE}|\u{10EF}\u{10EF}|\u{10F0}\u{10F0}|\u{10F1}\u{10F1}|\u{10F2}\u{10F2}|\u{10F3}\u{10F3}|" +
	"\u{10F4}\u{10F4}|\u{10F5}\u{10F5}|\u{10F6}\u{10F6}|\u{10F7}\u{10F7}|\u{10F8}\u{10F8}|\u{10F9}\u{10F9}|" +
	"\u{10FA}\u{10FA}|\u{10FD}\u{10FD}|\u{10FE}\u{10FE}|\u{10FF}\u{10FF}|\u{1F80}\u{1F88}|\u{1F81}\u{1F89}|" +
	"\u{1F82}\u{1F8A}|\u{1F83}\u{1F8B}|\u{1F84}\u{1F8C}|\u{1F85}\u{1F8D}|\u{1F86}\u{1F8E}|\u{1F87}\u{1F8F}|" +
	"\u{1F88}\u{1F88}|\u{1F89}\u{1F89}|\u{1F8A}\u{1F8A}|\u{1F8B}\u{1F8B}|\u{1F8C}\u{1F8C}|\u{1F8D}\u{1F8D}|" +
	"\u{1F8E}\u{1F8E}|\u{1F8F}\u{1F8F}|\u{1F90}\u{1F98}|\u{1F91}\u{1F99}|\u{1F92}\u{1F9A}|\u{1F93}\u{1F9B}|" +
	"\u{1F94}\u{1F9C}|\u{1F95}\u{1F9D}|\u{1F96}\u{1F9E}|\u{1F97}\u{1F9F}|\u{1F98}\u{1F98}|\u{1F99}\u{1F99}|" +
	"\u{1F9A}\u{1F9A}|\u{1F9B}\u{1F9B}|\u{1F9C}\u{1F9C}|\u{1F9D}\u{1F9D}|\u{1F9E}\u{1F9E}|\u{1F9F}\u{1F9F}|" +
	"\u{1FA0}\u{1FA8}|\u{1FA1}\u{1FA9}|\u{1FA2}\u{1FAA}|\u{1FA3}\u{1FAB}|\u{1FA4}\u{1FAC}|\u{1FA5}\u{1FAD}|" +
	"\u{1FA6}\u{1FAE}|\u{1FA7}\u{1FAF}|\u{1FA8}\u{1FA8}|\u{1FA9}\u{1FA9}|\u{1FAA}\u{1FAA}|\u{1FAB}\u{1FAB}|" +
	"\u{1FAC}\u{1FAC}|\u{1FAD}\u{1FAD}|\u{1FAE}\u{1FAE}|\u{1FAF}\u{1FAF}|\u{1FB2}\u{1FBA}\u{345}|\u{1FB3}\u{1FBC}|" +
	"\u{1FB4}\u{386}\u{345}|\u{1FB7}\u{391}\u{342}\u{345}|\u{1FBC}\u{1FBC}|\u{1FC2}\u{1FCA}\u{345}|\u{1FC3}\u{1FCC}|" +
	"\u{1FC4}\u{389}\u{345}|\u{1FC7}\u{397}\u{342}\u{345}|\u{1FCC}\u{1FCC}|\u{1FF2}\u{1FFA}\u{345}|\u{1FF3}\u{1FFC}|" +
	"\u{1FF4}\u{38F}\u{345}|\u{1FF7}\u{3A9}\u{342}\u{345}|\u{1FFC}\u{1FFC}|\u{FB00}\u{46}\u{66}|\u{FB01}\u{46}\u{69}|" +
	"\u{FB02}\u{46}\u{6C}|\u{FB03}\u{46}\u{66}\u{69}|\u{FB04}\u{46}\u{66}\u{6C}|\u{FB05}\u{53}\u{74}|\u{FB06}\u{53}\u{74}|" +
	"\u{FB13}\u{544}\u{576}|\u{FB14}\u{544}\u{565}|\u{FB15}\u{544}\u{56B}|\u{FB16}\u{54E}\u{576}|\u{FB17}\u{544}\u{56D}"

const TITLE_CASE = new Map(
	TITLE_CASE_EXCEPTIONS.split("|").map((entry) => {
		const [character, ...title] = [...entry]

		return [character!, title.join("")]
	})
)

/**
 * Python `str.capitalize()`: the first character in title case and the rest in lower case.
 *
 * Title case differs from upper case for 135 characters, among them `ß` (`Ss`),
 * the `ǆ` digraphs and the Georgian Mkhedruli letters, which stay lower case.
 *
 * Node's case mappings follow its own Unicode version.
 * Over every code point followed by `AbΣ`, 55 of 1,112,064 inputs differ from CPython 3.12.3,
 * each a character that gained a case mapping after Unicode 15.0.
 */
export function pythonCapitalize(text: string): string {
	const [first, ...rest] = [...text]

	if (first === undefined) return ""

	return (TITLE_CASE.get(first) ?? first.toUpperCase()) + rest.join("").toLowerCase()
}

/**
 * Python `str.split()` with no separator: the runs between whitespace, with no empty entry.
 */
export function pythonSplitWhitespace(text: string): string[] {
	const stripped = pythonStrip(text)

	return stripped ? stripped.split(SPACE_RUN) : []
}
