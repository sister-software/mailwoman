// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The generator behind the frozen comparison of the `structure` family.
 *
 *   `data/fixtures/query-shape-frozen.fixture.json` holds the output of the legacy `computeQueryShape`
 *   for inputs this generator drew (seed 20261116, 500 inputs) and for other draws.
 *   See `tools/frozen.ts`.
 *
 *   The generator also feeds the invariant test, and that test needs no reference.
 */

import { mulberry32 } from "@mailwoman/core/random"

/**
 * The alphabet of the generated inputs: ASCII letters and digits, the punctuation
 * and connectors the legacy code lists, white space with tab and newline, CJK, Kana,
 * Hangul, Cyrillic, Arabic, Greek, fullwidth forms, combining marks, a zero-width space,
 * other Unicode white space, astral codepoints and lone surrogates.
 */
const ALPHABET: readonly string[] = [
	..."abcxyzABCXYZNYDC0123456789",
	..."!\"#%&()*+,./:;<=>?@[\\]^`{|}~'-_",
	"¡",
	"¿",
	"“",
	"”",
	"–",
	"—",
	"‘",
	"’",
	"、",
	"。",
	" ",
	" ",
	"\t",
	"\n",
	"\r",
	" ",
	" ",
	" ",
	"　",
	"﻿",
	"​",
	"漢",
	"字",
	"々",
	"ひ",
	"カ",
	"ｶ",
	"한",
	"ᄀ",
	"ꀀ",
	"д",
	"Ж",
	"ع",
	"ـ",
	"α",
	"Ω",
	"Ａ",
	"１",
	"ー",
	"é",
	"×",
	"ǅ",
	"́",
	"ก",
	"😀",
	"\u{20000}",
	"\u{1B001}",
	"\uD800",
	"\uDC00",
]

/**
 * `count` random strings of up to `maxLength` characters over the alphabet.
 */
export function generatedInputs(count: number, seed: number, maxLength = 40): string[] {
	const random = mulberry32(seed)
	const out: string[] = []

	for (let index = 0; index < count; index++) {
		const length = Math.floor(random() * (maxLength + 1))
		let text = ""

		for (let position = 0; position < length; position++) {
			text += ALPHABET[Math.floor(random() * ALPHABET.length)]
		}

		out.push(text)
	}

	return out
}
