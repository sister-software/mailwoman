/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { CharacterClass, ScriptCode, ScriptShare, SpanRange, TokenCharacterClass, TokenClass } from "#types"

/**
 * The character class of a single codepoint.
 */
export type CodepointClass = TokenCharacterClass | "whitespace" | "connector" | "other"

const CJK_RANGES: ReadonlyArray<[number, number]> = [
	// These are the Han characters inside the CJK symbols block.
	// The iteration mark `々` appears inside names such as 代々木, so the tokenizer must not break a token at it.
	[0x30_05, 0x30_05],
	[0x30_07, 0x30_07],
	[0x30_21, 0x30_29],
	[0x30_38, 0x30_3b],
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

/**
 * Codepoint ranges per ISO 15924 script, most specific first.
 *
 * The `cjk` character class merges Kana, Han and Hangul.
 * These ranges keep the scripts apart so that consumers can tell Korean input from Japanese input.
 *
 * The ranges are written by hand because `computeQueryShape` runs on every keystroke.
 * `character-class.test.ts` checks every codepoint in every range against `\p{Script=…}`.
 *
 * Halfwidth and fullwidth forms belong to several scripts.
 * Fullwidth ASCII is Latin or Common, halfwidth katakana is Kana and halfwidth jamo is Hangul.
 */
const SCRIPT_RANGES: ReadonlyArray<readonly [ScriptCode, ReadonlyArray<[number, number]>]> = [
	[
		"Hira",
		[
			[0x30_41, 0x30_96], // Hiragana letters
			[0x30_9d, 0x30_9f], // Hiragana iteration marks and the digraph yori
			[0x1_b0_01, 0x1_b0_01], // Hiragana letter archaic ye
		],
	],
	[
		"Kana",
		[
			[0x30_a1, 0x30_fa], // Katakana letters
			[0x30_fd, 0x30_ff], // Katakana iteration marks and the digraph koto
			[0x31_f0, 0x31_ff], // Katakana phonetic extensions
			[0xff_66, 0xff_6f], // Halfwidth katakana, up to the prolonged sound mark
			[0xff_71, 0xff_9d], // Halfwidth katakana, past it
		],
	],
	[
		"Hang",
		[
			[0x11_00, 0x11_ff], // Hangul Jamo
			[0x31_31, 0x31_8e], // Hangul compatibility jamo
			[0x30_2e, 0x30_2f], // Hangul tone marks, inside the CJK punctuation block
			[0x32_00, 0x32_1e], // Parenthesized and circled Hangul
			[0x32_60, 0x32_7e],
			[0xa9_60, 0xa9_7c], // Hangul Jamo Extended-A
			[0xac_00, 0xd7_a3], // Hangul syllables
			[0xd7_b0, 0xd7_c6], // Hangul Jamo Extended-B, either side of the unassigned D7C7..D7CA
			[0xd7_cb, 0xd7_fb],
			// Halfwidth jamo, in the five runs the unassigned columns leave.
			[0xff_a0, 0xff_be],
			[0xff_c2, 0xff_c7],
			[0xff_ca, 0xff_cf],
			[0xff_d2, 0xff_d7],
			[0xff_da, 0xff_dc],
		],
	],
	[
		"Hani",
		[
			[0x2e_80, 0x2e_99], // CJK radicals supplement, either side of the unassigned 2E9A
			[0x2e_9b, 0x2e_f3],
			[0x2f_00, 0x2f_d5], // Kangxi radicals
			[0x30_05, 0x30_05], // The iteration mark 々
			[0x30_07, 0x30_07], // The ideographic number zero 〇
			[0x30_21, 0x30_29], // Hangzhou numerals
			[0x30_38, 0x30_3b],
			[0x34_00, 0x4d_bf], // CJK Unified Ideographs Extension A
			[0x4e_00, 0x9f_ff], // CJK Unified Ideographs
			[0xf9_00, 0xfa_6d], // CJK Compatibility Ideographs
			[0xfa_70, 0xfa_d9],
			[0x2_00_00, 0x2_a6_df], // CJK Unified Ideographs Extension B
		],
	],
	[
		"Latn",
		[
			[0x41, 0x5a],
			[0x61, 0x7a],
			[0x00_c0, 0x00_d6],
			[0x00_d8, 0x00_f6],
			[0x00_f8, 0x02_4f], // Latin-1 Supplement + Latin Extended-A/B
			[0x1e_00, 0x1e_ff], // Latin Extended Additional
			[0xff_21, 0xff_3a], // Fullwidth Latin capitals
			[0xff_41, 0xff_5a], // Fullwidth Latin small
		],
	],
	[
		"Cyrl",
		[
			[0x04_00, 0x04_84],
			[0x04_87, 0x04_ff],
			[0x05_00, 0x05_2f], // Cyrillic Supplement
			[0x2d_e0, 0x2d_ff], // Cyrillic Extended-A
			[0xa6_40, 0xa6_9f], // Cyrillic Extended-B
		],
	],
	[
		"Arab",
		[
			[0x06_20, 0x06_3f], // Arabic letters, either side of the tatweel
			[0x06_41, 0x06_4a],
			[0x06_56, 0x06_6f],
			[0x06_71, 0x06_dc],
			[0x06_de, 0x06_ff],
			[0x07_50, 0x07_7f], // Arabic Supplement
			[0x08_a0, 0x08_e1], // Arabic Extended-A, either side of the disputed end-of-ayah
			[0x08_e3, 0x08_ff],
			[0xfb_50, 0xfd_3d], // Arabic Presentation Forms-A
			[0xfd_40, 0xfd_cf],
			[0xfd_f0, 0xfd_ff],
			[0xfe_70, 0xfe_74], // Arabic Presentation Forms-B, either side of the unassigned FE75
			[0xfe_76, 0xfe_fc],
		],
	],
	[
		"Yiii",
		[
			[0xa0_00, 0xa4_8c], // Yi syllables
			[0xa4_90, 0xa4_c6], // Yi radicals
		],
	],
]

/**
 * Codepoints that Unicode assigns to `Common` inside blocks that otherwise belong to one script.
 *
 * These codepoints map to `Zyyy`, so script shares ignore them.
 * For example, the prolonged sound mark `ー` in `ブロードウェイ` does not count, and the word reads as `Kana` 1.00.
 */
const COMMON_RANGES: ReadonlyArray<[number, number]> = [
	[0x06_40, 0x06_40], // Arabic tatweel ـ, which stretches a joined letter
	// CJK symbols and punctuation, except the characters that Unicode assigns to Han: 々 (U+3005),
	// 〇 (U+3007), the Hangzhou numerals (U+3021..3029) and the ideographic marks U+3038..303B.
	[0x30_00, 0x30_04],
	[0x30_06, 0x30_06],
	[0x30_08, 0x30_20],
	[0x30_2a, 0x30_2d], // Ideographic tone marks. The adjacent U+302E..302F are Hangul tone marks.
	[0x30_30, 0x30_37],
	[0x30_3c, 0x30_3f],
	// The voiced marks and the katakana-hiragana double hyphen.
	// U+309D..309F are Hiragana.
	[0x30_99, 0x30_9c],
	[0x30_a0, 0x30_a0],
	[0x30_fb, 0x30_fc], // Katakana middle dot ・ and prolonged sound mark ー
	[0xff_01, 0xff_20], // Fullwidth punctuation and digits
	[0xff_3b, 0xff_40],
	[0xff_5b, 0xff_65],
	[0xff_70, 0xff_70], // Halfwidth prolonged sound mark ｰ
	[0xff_9e, 0xff_9f], // Halfwidth voiced marks
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
 * Connector codepoints join adjacent characters into one token, as in "10118-1234" and "O'Brien".
 */
const CONNECTOR_CODEPOINTS = new Set<number>([
	0x2d, // -
	0x27, // '
	0x5f, // _
	0x20_18, // ‘
	0x20_19, // ’
])

/**
 * Classifies a single Unicode codepoint.
 */
export function classifyCodepoint(cp: number): CodepointClass {
	if (cp >= 0x30 && cp <= 0x39) return "digit"

	if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) return "alpha"

	// Latin-1 letters with diacritics, Latin Extended-A/B and Latin Extended Additional.
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
 * Returns the ISO 15924 script of a single codepoint.
 *
 * `Zyyy` (Common) covers characters shared by many scripts, such as digits, commas and spaces.
 * `Zzzz` (Unknown) covers scripts that this file has no ranges for.
 *
 * Script shares skip `Zyyy` so that punctuation does not dominate every ranking.
 */
export function scriptForCodepoint(cp: number): ScriptCode {
	if (inRange(cp, COMMON_RANGES)) return "Zyyy"

	for (const [script, ranges] of SCRIPT_RANGES) {
		if (inRange(cp, ranges)) return script
	}

	const cls = classifyCodepoint(cp)

	if (cls === "digit" || cls === "punct" || cls === "whitespace" || cls === "connector") return "Zyyy"

	return "Zzzz"
}

/**
 * Returns the script of most codepoints in a token, ignoring `Zyyy` codepoints.
 *
 * A token with no script codepoints, such as `10118`, returns `Zyyy`.
 * A token mixes scripts only when a connector joins them, as in `ニューヨーク-NY`.
 *
 * The input's `scripts` list still reports both scripts in that case.
 */
export function classifyTokenScript(text: string): ScriptCode {
	const counts = new Map<ScriptCode, number>()

	for (let i = 0; i < text.length;) {
		const cp = text.codePointAt(i)!
		i += cp > 0xff_ff ? 2 : 1
		const script = scriptForCodepoint(cp)

		if (script === "Zyyy") continue

		counts.set(script, (counts.get(script) ?? 0) + 1)
	}

	let best: ScriptCode = "Zyyy"
	let bestCount = 0

	for (const [script, count] of counts) {
		if (count > bestCount) {
			best = script
			bestCount = count
		}
	}

	return best
}

/**
 * Returns every script in the input, ranked by share.
 *
 * Each share is a fraction of the codepoints that have a script, so digits and punctuation do not count.
 * For example, `金龍酒家, 12 Gerrard Street, London WC2H 7JS` gives `Latn` 0.82 and `Hani` 0.18.
 *
 * An input without script codepoints, such as a bare postcode, returns an empty list.
 *
 * This list distinguishes scripts that the folded `CharacterClass` merges into `cjk` or `mixed`.
 */
export function foldInputScripts(text: string): ScriptShare[] {
	const counts = new Map<ScriptCode, number>()
	let total = 0

	for (let i = 0; i < text.length;) {
		const cp = text.codePointAt(i)!
		i += cp > 0xff_ff ? 2 : 1
		const script = scriptForCodepoint(cp)

		if (script === "Zyyy") continue

		counts.set(script, (counts.get(script) ?? 0) + 1)

		total++
	}

	if (!total) return []

	return [...counts]
		.map(([script, count]) => ({ script, share: count / total }))
		.toSorted((left, right) => right.share - left.share || left.script.localeCompare(right.script))
}

/**
 * Classifies a token from the classes of its codepoints.
 *
 * Any CJK, Cyrillic or Arabic codepoint decides the class, in that order.
 * A token with both digits and Latin letters, such as `"221B"`, returns `"mixed"`.
 * A token of only punctuation returns `"punct"`.
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
 * Folds the token classes into one character class for the whole input.
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
 * Returns the script of the tokens that overlap the half-open range `[start, end)`.
 *
 * A part of an address can use a different script from the whole.
 * In `逊克二分场四队, heilongjiang, china`, the whole string is mostly `Latn`, but the first segment is `Hani`.
 *
 * Each token counts by its length in UTF-16 code units, so one long token can outweigh several short ones.
 * `Zyyy` tokens are skipped, and a range with only such tokens returns `Zyyy`.
 *
 * The offsets index the same normalized text as `TokenClass.span`.
 */
export function scriptForRange(tokens: ReadonlyArray<TokenClass>, start: number, end: number): ScriptCode {
	const weights = new Map<ScriptCode, number>()

	for (const token of tokens) {
		if (token.span.end <= start || token.span.start >= end) continue

		if (token.script === "Zyyy") continue

		weights.set(token.script, (weights.get(token.script) ?? 0) + (token.span.end - token.span.start))
	}

	let best: ScriptCode = "Zyyy"
	let bestWeight = 0

	for (const [script, weight] of weights) {
		if (weight > bestWeight) {
			best = script
			bestWeight = weight
		}
	}

	return best
}

/**
 * Tokenizes a string and returns each token with its class, length and script.
 *
 * `computeQueryShape` and the tests share this function so that every caller builds tokens the same way.
 */
export function classifyTokens(text: string): TokenClass[] {
	return tokenizeForClass(text).map((span) => ({
		span,
		class: classifyToken(span.body),
		length: span.end - span.start,
		script: classifyTokenScript(span.body),
	}))
}

/**
 * Splits a string into token spans at whitespace, punctuation and script changes.
 *
 * Most callers want {@linkcode classifyTokens}, which adds the class and the script to each span.
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

		// A connector at the start of a token is skipped like whitespace.
		if (cls === "connector") {
			i += cp > 0xff_ff ? 2 : 1

			continue
		}

		// The token runs until whitespace, punctuation or a class change.
		// Connectors stay inside it.
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

			// Digits and Latin letters share a token.
			// Other class changes end it, except that a token starting with an `other`
			// codepoint may continue into digits or letters.
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
