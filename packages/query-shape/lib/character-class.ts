/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { CharacterClass, ScriptCode, ScriptShare, SpanRange, TokenCharacterClass, TokenClass } from "#types"

/**
 * Codepoint-level character class.
 */
export type CodepointClass = TokenCharacterClass | "whitespace" | "connector" | "other"

const CJK_RANGES: ReadonlyArray<[number, number]> = [
	// The Han characters inside the CJK symbols block, which this list began at 0x3040 and so never held. `々` means
	// "repeat the previous character" and appears inside a name — 代々木, 佐々木, 酒々井町, 野々市市 — so classifying it
	// `other` made `tokenizeForClass` break the name at the one position that is not a boundary.
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
 * WHY THESE EXIST BESIDE `CJK_RANGES`. The class above buckets Kana, Han and Hangul as one `cjk` value, and that bucket
 * is what every consumer of a folded shape has to reason with — so `서울특별시 종로구` and `東京都千代田区` are the same input as far
 * as anything downstream can tell, and the locale hint answers `ja-JP` for both. The classes are not wrong for what
 * they are for: the tokenizer breaks a token at a script transition and the decoder wants to know whether a run is
 * ideographic. They just cannot carry the distinction, and the ranges to carry it were already in the file, merged.
 *
 * MEASURED AGAINST UNICODE'S OWN PROPERTY, not eyeballed: `character-class.test.ts` walks every codepoint in every
 * range below and asserts the answer equals `\p{Script=…}`. Hand ranges are here for the reason the rest of this file
 * uses them — `computeQueryShape` promises microseconds and runs per keystroke — and the test is what keeps them honest
 * as Unicode moves.
 *
 * Halfwidth and fullwidth forms split three ways rather than answering one script: fullwidth ASCII is Latin or common
 * by what it duplicates, halfwidth katakana is Kana, halfwidth jamo is Hangul.
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
			[0x30_05, 0x30_05], // 々 — the iteration mark, in 代々木 and 佐々木 and 酒々井町
			[0x30_07, 0x30_07], // 〇 — the ideographic number zero
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
 * Codepoints Unicode calls `Common` that sit inside blocks this file otherwise reads as a script.
 *
 * They answer `Zyyy`, which takes them out of both halves of every share — and that is what makes the share readable.
 * `ブロードウェイ` is seven characters, two of them the prolonged sound mark `ー`; folding that mark into neither script
 * reports `Kana 1.00`, and the first version of this table, which had no entry for it, reported `Kana 0.67 / Zzzz 0.20`
 * and made an ordinary katakana word look a fifth unrecognized.
 *
 * The voiced marks and the middle dot are the same case: a Japanese-specific character that belongs to no one script,
 * because both kana use it.
 */
const COMMON_RANGES: ReadonlyArray<[number, number]> = [
	[0x06_40, 0x06_40], // Arabic tatweel ـ — a letter-joining stretch, not a letter
	// CJK symbols and punctuation, MINUS the characters in that block Unicode assigns to Han: 々 (U+3005), 〇 (U+3007),
	// the Hangzhou numerals (U+3021..3029) and the ideographic marks U+3038..303B. The first version of this list took
	// the block whole and answered `Zyyy` for the iteration mark, which appears in 代々木 and 佐々木 and 酒々井町.
	[0x30_00, 0x30_04],
	[0x30_06, 0x30_06],
	[0x30_08, 0x30_20],
	[0x30_2a, 0x30_2d], // Ideographic tone marks; U+302E..302F beside them are HANGUL tone marks
	[0x30_30, 0x30_37],
	[0x30_3c, 0x30_3f],
	// The voiced marks and the katakana-hiragana double hyphen, MINUS U+309D..309F, which are Hiragana: the iteration
	// marks ゝゞ and the digraph yori. Same defect as the block above, one range over.
	[0x30_99, 0x30_9c],
	[0x30_a0, 0x30_a0],
	[0x30_fb, 0x30_fc], // Katakana middle dot ・ and prolonged sound mark ー
	[0xff_01, 0xff_20], // Fullwidth punctuation and digits
	[0xff_3b, 0xff_40],
	[0xff_5b, 0xff_65],
	[0xff_70, 0xff_70], // Halfwidth prolonged sound mark ｰ — the halfwidth twin of U+30FC
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
 * The ISO 15924 script a single codepoint is written in.
 *
 * `Zyyy` is Unicode's own answer for a character that belongs to no one script — a digit, a comma, a space — and it is
 * a real answer rather than a failure: `10118` is script-neutral in every language that writes it. `Zzzz` is the
 * unknown case, which here means a script this file has no ranges for. The two are kept apart because a ranked script
 * list that counted every comma would report `Zyyy` first on every input.
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
 * The script a token is written in: the one the most of its script-containing codepoints carry.
 *
 * A token that carries none — `10118`, `-` — answers `Zyyy` rather than guessing from its neighbours. The tokenizer
 * breaks at a script transition, so a token mixing two scripts is rare and comes from a connector joining them
 * (`ニューヨーク-NY`); the majority answer names the one that writes most of it and `scripts` on the whole shape still
 * reports both.
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
 * Every script the input is written in, ranked by how much of it they write.
 *
 * `share` is the proportion of script-containing codepoints, so the digits and the commas are out of both halves of the
 * fraction: `金龍酒家, 12 Gerrard Street, London WC2H 7JS` answers `Latn` 0.82 / `Hani` 0.18 rather than burying both under
 * the punctuation. An input carrying no script-containing codepoint at all — a bare postcode — answers an empty list,
 * which is the honest reading: nothing in `10118` names a script.
 *
 * This is the field that carries what the folded `CharacterClass` cannot. `cjk` is one value for three scripts, and a
 * `mixed` input names no script at all, so a Han venue inside a London address was invisible to every consumer that
 * read the fold.
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
 * The script a RANGE of the input is written in, given the tokens already classified for it.
 *
 * The answer for a whole string is not the answer for its parts, and for an address the parts are what a caller usually
 * has. `逊克二分场四队, HEILONGJIANG, CHINA` is `Latn` 0.71 / `Hani` 0.29 as a string, because the romanized province and
 * country outweigh the Han unit — but its first segment is `Hani`, its second and third are `Latn`, and a rule about
 * how to render or route the unit wants the first of those, not the average of all three.
 *
 * Weighted by CODEPOINTS rather than by token count, so one long Han run is not outvoted by three short Latin ones, and
 * `Zyyy` tokens abstain: a range holding only a house number answers `Zyyy` rather than borrowing a neighbour's script.
 * Offsets are half-open and are the ones `TokenClass.span` carries, so a `Segment`, a component span or any pair of
 * indices into the same normalized text can be passed straight in.
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
 * Every token of a string with its class and its script — the whole per-token half of a `QueryShape`.
 *
 * Exported because it was typed three times: `computeQueryShape` builds it, and two test files rebuilt it to feed
 * `detectKnownFormats` and `detectRegionAbbreviations`. Adding `script` broke all three, which is the tell — a shape
 * assembled in more than one place grows a field in one of them.
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
 * Walk a string and emit token spans (whitespace-and-punctuation-separated). Callers usually want
 * {@linkcode classifyTokens}, which adds the class and the script to each span.
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
