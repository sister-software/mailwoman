/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Japanese address text: the prefecture set, field normalizers, and the chōme split. The corpus
 *   assembler renders with and the corporate-register reader matches with.
 *
 *   Ported from the Python builders' `countries/jp/text.py`.
 */

import { JP_PREFECTURES as CODEX_JP_PREFECTURES } from "@mailwoman/codex/jp"
import { splitWhitespace } from "@mailwoman/core/strings/unicode"

import { foldHalfwidthKana, kanjiToInt } from "#cjk/text"

/**
 * The 47 prefecture names, in kanji.
 *
 * Overture's `address_levels[0]` holds occasional junk (`東京都1`), which this set excludes.
 */
export const JP_PREFECTURE_NAMES: ReadonlySet<string> = new Set(
	Object.values(CODEX_JP_PREFECTURES).map((prefecture) => prefecture.kanji)
)

/**
 * The hyphen equivalents folded in a number field only.
 *
 * U+30FC and U+FF70 are prolonged-sound marks inside a katakana name,
 * and an IME types them as hyphens in a banchi-go.
 */
const HYPHEN_CLASS = /[‐‑‒–—―−ー﹘﹣－ｰ]/gu

/**
 * The variant hyphens a keyboard or IME emits, for the robustness fraction.
 *
 * U+30FC is the one a Japanese IME produces from the key beside 0 in kana mode.
 */
export const VARIANT_HYPHENS: readonly string[] = ["ー", "−", "－"]

const CHOME_TAIL = /^(.*?)([0-9０-９〇一二三四五六七八九十百]+)丁目$/u

/**
 * A name field (prefecture, municipality or street): NFC, half-width kana folded,
 * every whitespace character removed.
 *
 * Hyphens are kept, because U+30FC is a katakana character in a name, and itaiji are not folded.
 */
export function normalizeJPName(text: string): string {
	return splitWhitespace(foldHalfwidthKana(text.normalize("NFC"))).join("")
}

/**
 * A number field: NFC, half-width kana folded, and every hyphen equivalent folded to `-`.
 */
export function normalizeJPNumber(text: string): string {
	return foldHalfwidthKana(text.normalize("NFC")).replace(HYPHEN_CLASS, "-").trim()
}

/**
 * An Overture `street` value split into its district and its chōme number,
 * or `null` for the number when it has no trailing 丁目.
 *
 * `八島町二丁目` splits to `八島町` and 2, `字崎枝` to itself and `null`, `二丁目` to `""` and 2.
 * A non-trailing 丁目 stays whole as the district.
 */
export function splitJPStreet(street: string): readonly [district: string, chome: number | null] {
	const match = CHOME_TAIL.exec(street)

	if (!match) return [street, null]

	const value = kanjiToInt(match[2]!)

	if (value === null) return [street, null]

	return [match[1]!, value]
}
