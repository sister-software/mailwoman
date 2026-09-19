/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Normalizes CJK punctuation and width variants without transliterating names or numeral kanji.
 *   Offset-map entries for contracted half-width katakana point to the first source unit.
 */

import { identityMap } from "#offset-map"

export interface CjkResult {
	text: string
	map: number[]
	/**
	 * Count of characters folded in place (full-width → ascii, ideographic space → ' ').
	 */
	folded: number
	/**
	 * Count of characters dropped (the postal mark).
	 */
	stripped: number
}

/**
 * ！.
 */
const FULLWIDTH_START = 0xff_01
/**
 * ～.
 */
const FULLWIDTH_END = 0xff_5e
/**
 * U+FFxx − 0xFEE0 = U+00xx.
 */
const FULLWIDTH_TO_ASCII = 0xfe_e0
const IDEOGRAPHIC_SPACE = 0x30_00
/**
 * 〒.
 */
const POSTAL_MARK = 0x30_12
const HALFWIDTH_KATAKANA_START = 0xff_61
const HALFWIDTH_KATAKANA_END = 0xff_9f
const HALFWIDTH_VOICING_START = 0xff_9e

function isHalfwidthKatakana(code: number): boolean {
	return code >= HALFWIDTH_KATAKANA_START && code <= HALFWIDTH_KATAKANA_END
}

export function applyCjkNormalization(input: string, opts: { postalMark?: "strip" | "keep" } = {}): CjkResult {
	let folded = 0
	let stripped = 0
	const out: string[] = []
	const map: number[] = []
	const stripPostalMark = opts.postalMark !== "keep"

	// All transformed code points are in the BMP (single UTF-16 unit), and every other character is
	// passed through verbatim, so a per-unit walk is safe for surrogate-pair input too.
	for (let i = 0; i < input.length; i++) {
		const code = input.charCodeAt(i)

		if (code === POSTAL_MARK && stripPostalMark) {
			stripped += 1

			continue // drop — no addressing content. whitespace collapse later tidies any gap
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

		if (isHalfwidthKatakana(code)) {
			const next = input.charCodeAt(i + 1)

			const consumesVoicingMark =
				code < HALFWIDTH_VOICING_START && next >= HALFWIDTH_VOICING_START && next <= HALFWIDTH_KATAKANA_END

			const width = consumesVoicingMark ? 2 : 1

			const normalized = input
				.slice(i, i + width)
				.normalize("NFKC")
				.normalize("NFC")

			for (const unit of normalized) {
				out.push(unit)
				map.push(i)
			}

			folded += width
			i += width - 1

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
