/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { CharacterClass, SpanRange, TokenCharacterClass, TokenClass } from "./types.ts"

/**
 * Codepoint-level character class.
 */
export type CodepointClass = TokenCharacterClass | "whitespace" | "connector" | "other"

const CJK_RANGES: ReadonlyArray<[number, number]> = [
	[0x30_40, 0x30_ff], // Hiragana + Katakana
	[0x31_f0, 0x31_ff], // Katakana phonetic extensions
	[0x34_00, 0x4d_bf], // CJK Unified Ideographs Extension A
	[0x4e_00, 0x9f_ff], // CJK Unified Ideographs
	[0xa0_00, 0xa4_cf], // Yi
	[0xac_00, 0xd7_af], // Hangul Syllables
	[0xf9_00, 0xfa_ff], // CJK Compatibility Ideographs
	[0xff_00, 0xff_ef], // Halfwidth + Fullwidth forms
	[0x2_00_00, 0x2_a6_df], // CJK Unified Ideographs Extension B
]

const CYRILLIC_RANGES: ReadonlyArray<[number, number]> = [
	[0x04_00, 0x04_ff],
	[0x05_00, 0x05_2f], // Cyrillic Supplement
	[0x2d_e0, 0x2d_ff], // Cyrillic Extended-A
	[0xa6_40, 0xa6_9f], // Cyrillic Extended-B
]

const ARABIC_RANGES: ReadonlyArray<[number, number]> = [
	[0x06_00, 0x06_ff],
	[0x07_50, 0x07_7f], // Arabic Supplement
	[0x08_a0, 0x08_ff], // Arabic Extended-A
	[0xfb_50, 0xfd_ff], // Arabic Presentation Forms-A
	[0xfe_70, 0xfe_ff], // Arabic Presentation Forms-B
]

function inRange(cp: number, ranges: ReadonlyArray<[number, number]>): boolean {
	for (const [lo, hi] of ranges) {
		if (cp >= lo && cp <= hi) return true
	}

	return false
}

const PUNCT_CODEPOINTS = new Set<number>([
	0x21, // !
	0x22, // "
	0x23, // #
	0x25, // %
	0x26, // &
	0x28, // (
	0x29, // )
	0x2a, // *
	0x2b, // +
	0x2c, // ,
	0x2e, // .
	0x2f, // /
	0x3a, // :
	0x3b, // ;
	0x3c, // <
	0x3d, // =
	0x3e, // >
	0x3f, // ?
	0x40, // @
	0x5b, // [
	0x5c, // \
	0x5d, // ]
	0x5e, // ^
	0x60, // `
	0x7b, // {
	0x7c, // |
	0x7d, // }
	0x7e, // ~
	0x00_a1, // ¡
	0x00_bf, // ¿
	0x20_1c, // “
	0x20_1d, // ”
	0x20_13, // –
	0x20_14, // —
	0x30_01, // 、 (CJK comma)
	0x30_02, // 。 (CJK period)
])

/**
 * "Connector" codepoints join adjacent tokens instead of separating them. Hyphen, apostrophe, underscore — surface in
 * "10118-1234", "O'Brien", "Saint-Denis", and similar.
 */
const CONNECTOR_CODEPOINTS = new Set<number>([
	0x2d, // -
	0x27, // '
	0x5f, // _
	0x20_18, // ‘
	0x20_19, // ’
])

/**
 * Classify a single Unicode codepoint.
 */
export function classifyCodepoint(cp: number): CodepointClass {
	if (cp >= 0x30 && cp <= 0x39) return "digit"

	if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) return "alpha"

	// Latin-1 letters with diacritics + Latin Extended-A/B
	if ((cp >= 0x00_c0 && cp <= 0x02_4f) || (cp >= 0x1e_00 && cp <= 0x1e_ff)) return "alpha"

	if (cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0xa0) return "whitespace"

	if (CONNECTOR_CODEPOINTS.has(cp)) return "connector"

	if (PUNCT_CODEPOINTS.has(cp)) return "punct"

	if (inRange(cp, CJK_RANGES)) return "cjk"

	if (inRange(cp, CYRILLIC_RANGES)) return "cyrillic"

	if (inRange(cp, ARABIC_RANGES)) return "arabic"

	return "other"
}

/**
 * Classify a token by walking its codepoints and folding to the dominant class. Mixed alphanumeric (e.g. `"221B"`,
 * `"10118-1234"`) returns `"mixed"`. Pure-punct tokens return `"punct"`.
 */
export function classifyToken(text: string): TokenCharacterClass {
	let hasDigit = false
	let hasAlpha = false
	let hasCjk = false
	let hasCyrillic = false
	let hasArabic = false
	let hasPunct = false

	for (let i = 0; i < text.length;) {
		const cp = text.codePointAt(i)!
		i += cp > 0xff_ff ? 2 : 1
		const cls = classifyCodepoint(cp)

		switch (cls) {
			case "digit":
				hasDigit = true
				break
			case "alpha":
				hasAlpha = true
				break
			case "cjk":
				hasCjk = true
				break
			case "cyrillic":
				hasCyrillic = true
				break
			case "arabic":
				hasArabic = true
				break
			case "punct":
				hasPunct = true
				break
			case "connector":
			case "whitespace":
			case "other":
				break
		}
	}

	if (hasCjk) return "cjk"

	if (hasCyrillic) return "cyrillic"

	if (hasArabic) return "arabic"

	if (hasDigit && hasAlpha) return "mixed"

	if (hasDigit) return "digit"

	if (hasAlpha) return "alpha"

	if (hasPunct) return "punct"

	return "mixed"
}

/**
 * Fold per-token classes into the whole-input character class.
 */
export function foldInputClass(tokens: ReadonlyArray<TokenClass>): CharacterClass {
	if (!tokens.length) return "alpha"

	let hasDigit = false
	let hasAlpha = false
	let hasCjk = false
	let hasCyrillic = false
	let hasArabic = false
	let hasMixed = false

	for (const t of tokens) {
		switch (t.class) {
			case "cjk":
				hasCjk = true
				break
			case "cyrillic":
				hasCyrillic = true
				break
			case "arabic":
				hasArabic = true
				break
			case "digit":
				hasDigit = true
				break
			case "alpha":
				hasAlpha = true
				break
			case "mixed":
				hasMixed = true
				break
		}
	}

	if (hasCjk && !hasAlpha && !hasCyrillic && !hasArabic) return "cjk"

	if (hasCyrillic && !hasAlpha && !hasCjk && !hasArabic) return "cyrillic"

	if (hasArabic && !hasAlpha && !hasCjk && !hasCyrillic) return "arabic"

	if (hasCjk || hasCyrillic || hasArabic) return "mixed"

	if (hasMixed || (hasDigit && hasAlpha)) return "alphanumeric"

	if (hasDigit && !hasAlpha) return "numeric"

	if (hasAlpha && !hasDigit) return "alpha"

	return "mixed"
}

/**
 * Walk a string and emit token spans (whitespace-and-punctuation-separated). Internal helper — callers receive
 * `TokenClass[]` from `computeQueryShape`.
 */
export function tokenizeForClass(text: string): SpanRange[] {
	const tokens: SpanRange[] = []
	let i = 0
	const N = text.length

	while (i < N) {
		const cp = text.codePointAt(i)!
		const cls = classifyCodepoint(cp)

		if (cls === "whitespace" || cls === "punct") {
			i += cp > 0xff_ff ? 2 : 1
			continue
		}

		// A leading connector (rare — most inputs don't start with `-`/`'`) is consumed as whitespace.
		if (cls === "connector") {
			i += cp > 0xff_ff ? 2 : 1
			continue
		}

		// Start a token at i; walk until we hit whitespace, punct, or a script boundary.
		// Connectors (`-`, `'`, `_`) join across digit/alpha boundaries.
		const start = i
		const startCls = cls
		let cur = i

		while (cur < N) {
			const ncp = text.codePointAt(cur)!
			const nstep = ncp > 0xff_ff ? 2 : 1
			const ncls = classifyCodepoint(ncp)

			if (ncls === "whitespace" || ncls === "punct") break

			if (ncls === "connector") {
				cur += nstep
				continue
			}
			// Break tokens across script transitions (digit↔alpha is fine; alpha↔cjk is a boundary).
			const isLatinPair = (a: CodepointClass, b: CodepointClass) =>
				(a === "digit" || a === "alpha") && (b === "digit" || b === "alpha")

			if (
				ncls !== startCls &&
				!isLatinPair(startCls, ncls) &&
				!(startCls === "other" && (ncls === "digit" || ncls === "alpha"))
			) {
				break
			}
			cur += nstep
		}

		tokens.push({ start, end: cur, body: text.slice(start, cur) })
		i = cur
	}

	return tokens
}
