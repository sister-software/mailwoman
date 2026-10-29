/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Script-level text handling the JP, KR, TW and CJK builders share: whitespace-free NFC field values, the
 *   two digit registers, half-width kana folding and the kanji numerals.
 *
 *   Ported from the Python builders' `text/normalize.py` and `text/kana.py`, so a join key or a rendered numeral
 *   equals the one the Python builders wrote.
 */

import { pythonIsDigit, pythonSplitWhitespace } from "@mailwoman/core/strings/python-text"

const FULLWIDTH_DIGITS = "０１２３４５６７８９"

/**
 * NFC with every whitespace character removed, interior included, because no CJK
 * address component holds an interior space.
 *
 * It is the join key the KEN_ALL probe and the TW builder use.
 */
export function normalizeCJKText(text: string): string {
	return pythonSplitWhitespace(text.normalize("NFC")).join("")
}

/**
 * Full-width numerals folded to ASCII, every other character kept.
 */
export function asciiDigits(text: string): string {
	return text.replaceAll(/[０-９]/gu, (digit) => String(FULLWIDTH_DIGITS.indexOf(digit)))
}

/**
 * ASCII numerals rendered full width, the register a TW source writes numerals in.
 */
export function fullwidthDigits(text: string): string {
	return text.replaceAll(/[0-9]/gu, (digit) => FULLWIDTH_DIGITS[Number(digit)]!)
}

const isHalfwidthKana = (character: string): boolean => {
	const code = character.codePointAt(0)!

	return code >= 0xff_61 && code <= 0xff_9f
}

/**
 * Half-width katakana (U+FF61–FF9F) folded to full width, with the dakuten composed.
 *
 * Only those characters are folded, because NFKC would also fold full-width digits to ASCII.
 * The fold changes the length (`ﾃﾞ` becomes `デ`), so it runs on field values
 * before their spans are recorded.
 */
export function foldHalfwidthKana(text: string): string {
	const characters = [...text]

	if (!characters.some(isHalfwidthKana)) return text

	return characters
		.map((character) => (isHalfwidthKana(character) ? character.normalize("NFKC") : character))
		.join("")
		.normalize("NFC")
}

const KANJI_DIGITS: Readonly<Record<string, number>> = {
	〇: 0,
	一: 1,
	二: 2,
	三: 3,
	四: 4,
	五: 5,
	六: 6,
	七: 7,
	八: 8,
	九: 9,
}

const KANJI_DIGIT_ORDER = "〇一二三四五六七八九"
const TEN = 10
const HUNDRED = 100

/**
 * A Japanese numeral in either register as an integer, or `null` when the text is not one.
 *
 * It reads bare digits (ASCII or full width), the digit-string kanji register (`〇一二`),
 * and the positional kanji register up to 百 (`二十三`).
 */
export function kanjiToInt(text: string): number | null {
	if (!text) return null

	const asciiForm = text.normalize("NFKC")

	if (pythonIsDigit(asciiForm)) {
		const value = Number(asciiForm)

		// `int()` reads every Unicode decimal digit.
		// Past NFKC, `Number` reads only the ASCII ones.
		if (Number.isSafeInteger(value)) return value
	}

	const characters = [...text]

	if (characters.every((character) => character in KANJI_DIGITS)) {
		return Number(characters.map((character) => KANJI_DIGITS[character]).join(""))
	}

	let total = 0
	let current = 0

	for (const character of characters) {
		if (character === "十") {
			total += (current || 1) * TEN
			current = 0
		} else if (character === "百") {
			total += (current || 1) * HUNDRED
			current = 0
		} else if (character in KANJI_DIGITS) {
			current = KANJI_DIGITS[character]!
		} else {
			return null
		}
	}

	return total + current
}

/**
 * An integer in the positional kanji register, the register the sources' 丁目 use.
 *
 * @throws When `value` is negative.
 */
export function intToKanji(value: number): string {
	if (value < 0) throw new Error(`negative chōme: ${value}`)

	if (value < TEN) return KANJI_DIGIT_ORDER[value]!

	if (value < HUNDRED) {
		const tens = Math.floor(value / TEN)
		const ones = value % TEN

		return (tens === 1 ? "" : KANJI_DIGIT_ORDER[tens]!) + "十" + (ones ? KANJI_DIGIT_ORDER[ones]! : "")
	}

	const hundreds = Math.floor(value / HUNDRED)
	const rest = value % HUNDRED

	if (hundreds >= TEN) throw new Error(`chōme ${value} is beyond the positional register's 百`)

	const head = (hundreds === 1 ? "" : KANJI_DIGIT_ORDER[hundreds]!) + "百"

	return head + (rest ? intToKanji(rest) : "")
}
