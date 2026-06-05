/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   CJK input normalization (Direction E, #291) — a conservative, character-level pass that runs as
 *   part of `normalize()` so the parser sees a stable form of CJK addresses. It does only the
 *   transformations that are UNAMBIGUOUS in any context:
 *
 *   - **Strip the postal mark 〒 (U+3012).** The JP cheap-probe found 〒 is byte-fallback OOV for the
 *       SentencePiece tokenizer — it fragments into raw UTF-8 byte pieces and poisons the parse of
 *       the digits right after it (the postcode gets mislabeled as a house number). It's a
 *       "postcode follows" marker with no addressing content of its own, so dropping it is safe and
 *       fixes the bug.
 *   - **Fold full-width ASCII (U+FF01–U+FF5E → U+0021–U+007E).** A full-width `１` is always the digit
 *       1, a full-width `－` always a hyphen — keyboards and copy-paste produce these constantly.
 *       Folding them to ASCII makes `１０４−００６１` and `104-0061` the same input.
 *   - **Fold the ideographic space (U+3000 → ' ').**
 *
 *   It deliberately does NOT convert **kanji numerals** (一二三…): place names carry numeral kanji as
 *   ordinary characters (三田 _Mita_, 四谷 _Yotsuya_), so a blind 三→3 would corrupt them.
 *   Disambiguating "this 三 is a block number, that one is part of a name" is parsing, not
 *   normalization — deferred. Kana→kanji transliteration (ちょうめ→丁目) is dictionary work and likewise
 *   deferred.
 *
 *   Self-gating: a string with none of these characters returns identity, so Latin input is
 *   untouched.
 */

import { identityMap } from "./offset-map.js"

export interface CjkResult {
	text: string
	map: number[]
	/** Count of characters folded in place (full-width → ASCII, ideographic space → ' '). */
	folded: number
	/** Count of characters dropped (the postal mark). */
	stripped: number
}

const FULLWIDTH_START = 0xff01 // ！
const FULLWIDTH_END = 0xff5e // ～
const FULLWIDTH_TO_ASCII = 0xfee0 // U+FFxx − 0xFEE0 = U+00xx
const IDEOGRAPHIC_SPACE = 0x3000
const POSTAL_MARK = 0x3012 // 〒

export function applyCjkNormalization(input: string): CjkResult {
	let folded = 0
	let stripped = 0
	const out: string[] = []
	const map: number[] = []

	// All transformed code points are in the BMP (single UTF-16 unit), and every other character is
	// passed through verbatim, so a per-unit walk is safe for surrogate-pair input too.
	for (let i = 0; i < input.length; i++) {
		const code = input.charCodeAt(i)
		if (code === POSTAL_MARK) {
			stripped += 1
			continue // drop — no addressing content; whitespace collapse later tidies any gap
		}
		if (code >= FULLWIDTH_START && code <= FULLWIDTH_END) {
			out.push(String.fromCharCode(code - FULLWIDTH_TO_ASCII))
			map.push(i)
			folded += 1
			continue
		}
		if (code === IDEOGRAPHIC_SPACE) {
			out.push(" ")
			map.push(i)
			folded += 1
			continue
		}
		out.push(input[i]!)
		map.push(i)
	}

	if (folded === 0 && stripped === 0) {
		return { text: input, map: identityMap(input.length), folded: 0, stripped: 0 }
	}
	return { text: out.join(""), map, folded, stripped }
}
