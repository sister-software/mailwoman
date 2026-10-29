/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The strings a trained tokenizer keeps whole, and how they reach SentencePiece.
 *
 *   A user-defined symbol bypasses unigram inference and is always emitted as one piece. The literal a caller writes
 *   is not the literal SentencePiece matches: it turns whitespace into `▁` before matching, so `PO Box` is passed as
 *   `PO▁Box`. The symbols also compete with the vocabulary budget, so a list longer than a quarter of the vocabulary
 *   is truncated.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { pythonRightStrip, pythonStrip } from "@mailwoman/core/strings/python-text"

/**
 * The default symbols: US state and territory codes, country abbreviations
 * and names, and postal-form anchors.
 *
 * A state code beside a postcode (`NY 10001`) stays one piece, so the region and postcode stay adjacent.
 * Postal markers (`PO Box`, `Cedex`, `BP`) are fixed surface forms that are
 * cheaper to add once than to learn.
 *
 * A hyphen is not listed because it already tokenizes as one piece.
 * Whole Japanese postcodes come from mined postcode literals.
 *
 * The list keeps its duplicates (`CA`, `DE`), which the trainer removes.
 */
export const DEFAULT_USER_DEFINED_SYMBOLS: readonly string[] = [
	// US states and territories.
	..."AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR VI GU AS MP".split(
		" "
	),
	// Country abbreviations and names.
	"USA",
	"US",
	"U.S.",
	"U.S.A.",
	"FR",
	"FRA",
	"France",
	"JP",
	"JPN",
	"Japan",
	"GB",
	"UK",
	"U.K.",
	"DE",
	"DEU",
	"Germany",
	"IT",
	"ITA",
	"Italy",
	"ES",
	"ESP",
	"Spain",
	"NL",
	"NLD",
	"Netherlands",
	"CA",
	"CAN",
	"Canada",
	"AU",
	"AUS",
	"Australia",
	"CH",
	"CHE",
	"Switzerland",
	"BE",
	"BEL",
	"Belgium",
	"AT",
	"AUT",
	"Austria",
	"SE",
	"SWE",
	"Sweden",
	"RU",
	"RUS",
	// Postal-form anchors.
	"PO Box",
	"P.O. Box",
	"P.O.Box",
	"POB",
	"Apt",
	"Apt.",
	"Suite",
	"Ste",
	"Cedex",
	"CEDEX",
	"BP",
]

/**
 * The single characters besides `\r\n` that Python's `str.splitlines` splits on, as a character class body.
 */
const PYTHON_LINE_BREAK_CHARACTERS = "\\n\\r\\v\\f\\x1c-\\x1e\\x85\\u2028\\u2029"

/**
 * The line breaks Python's `str.splitlines` splits on.
 */
export const PYTHON_LINE_BREAK = new RegExp(`\\r\\n|[${PYTHON_LINE_BREAK_CHARACTERS}]`)

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
 * One literal per line.
 *
 * A blank line or a `#` comment is skipped, and only line ends are trimmed,
 * because a symbol may hold a space (`PO Box`).
 */
export async function readUserDefinedSymbolsFile(path: string): Promise<string[]> {
	return pythonSplitLines(await readLocalTextFile(path))
		.map(pythonRightStrip)
		.filter((line) => line && !pythonStrip(line).startsWith("#"))
}

/**
 * A symbol with each ASCII space replaced by SentencePiece's whitespace placeholder, `▁`.
 */
export function sentencePieceSymbol(symbol: string): string {
	return symbol.replaceAll(" ", "▁")
}

/**
 * The non-empty entries, first occurrences only, in order.
 */
export function dedupeKeepOrder(items: Iterable<string>): string[] {
	return [...new Set([...items].filter((item) => item.length > 0))]
}
