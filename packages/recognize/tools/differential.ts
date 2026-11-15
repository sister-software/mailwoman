// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The comparison of the `structure` family with `computeQueryShape` of `@mailwoman/query-shape`.
 *
 *   The two return the same six fields for the same text, on every input: `characterClass`,
 *   `scripts`, `tokenClasses`, `segments`, `regionAbbreviations` and `totalLength`.
 *   `knownFormats` belongs to the postal family and `whitespacePattern` is dropped.
 *
 *   The legacy `TokenClass.length` has no reader anywhere in the repository,
 *   so the family omits it, and the comparison removes it from the legacy value.
 *   The legacy `Segment.index` is kept.
 *
 *   The test, the real-row tool and the benchmark share this module.
 */

import { mulberry32 } from "@mailwoman/core/random"
import { computeQueryShape } from "@mailwoman/query-shape"

import { createRecognizer } from "#index"
import { structure } from "#structure"

const recognizer = createRecognizer([structure])

/**
 * The six fields, as plain data in a fixed key order.
 */
export interface SixFields {
	characterClass: string
	scripts: unknown
	tokenClasses: unknown
	segments: unknown
	regionAbbreviations: unknown
	totalLength: number
}

/**
 * The six fields `computeQueryShape` returns, without `TokenClass.length`.
 */
export function legacyFields(text: string): SixFields {
	const shape = computeQueryShape(text)

	return {
		characterClass: shape.characterClass,
		scripts: shape.scripts.map(({ script, share }) => ({ script, share })),
		tokenClasses: shape.tokenClasses.map(({ span, class: tokenClass, script }) => ({
			span: { start: span.start, end: span.end, body: span.body },
			class: tokenClass,
			script,
		})),
		segments: shape.segments.map(({ span, body, index, separator }) => ({
			span: { start: span.start, end: span.end, body: span.body },
			body,
			index,
			separator,
		})),
		regionAbbreviations: shape.regionAbbreviations.map(({ start, span }) => ({ start, span })),
		totalLength: shape.totalLength,
	}
}

/**
 * The six fields `recognize` returns with the `structure` family composed.
 */
export function recognizedFields(text: string): SixFields {
	const { fields } = recognizer.recognize(text)

	return {
		characterClass: fields.characterClass,
		scripts: fields.scripts.map(({ script, share }) => ({ script, share })),
		tokenClasses: fields.tokenClasses.map(({ span, class: tokenClass, script }) => ({
			span: { start: span.start, end: span.end, body: span.body },
			class: tokenClass,
			script,
		})),
		segments: fields.segments.map(({ span, body, index, separator }) => ({
			span: { start: span.start, end: span.end, body: span.body },
			body,
			index,
			separator,
		})),
		regionAbbreviations: fields.regionAbbreviations.map(({ start, span }) => ({ start, span })),
		totalLength: fields.totalLength,
	}
}

/**
 * One input on which the two disagree.
 */
export interface Difference {
	input: string
	legacy: SixFields
	recognized: SixFields
}

/**
 * Compares the two on `text`, and returns the difference or `null`.
 */
export function compareOne(text: string): Difference | null {
	const legacy = legacyFields(text)
	const recognized = recognizedFields(text)

	// oxlint-disable-next-line no-restricted-properties -- the comparison needs a canonical text of plain data, and the values are not external input
	return JSON.stringify(legacy) === JSON.stringify(recognized) ? null : { input: text, legacy, recognized }
}

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

/**
 * Every code unit and every codepoint in chunks, in three layouts, so every codepoint
 * appears at a token start, inside a token and as a one-codepoint text.
 * Lone surrogates are the code units D800 to DFFF.
 */
export function* codepointInputs(chunk = 2048): Generator<{ first: number; text: string }> {
	for (let first = 0; first <= 0x10_ff_ff; first += chunk) {
		const last = Math.min(first + chunk, 0x11_00_00)
		const pieces: string[] = []

		for (let codepoint = first; codepoint < last; codepoint++) {
			const character = String.fromCodePoint(codepoint)

			pieces.push(`a${character}1`, character, `${character}${character}`)
		}

		yield { first, text: pieces.join(" ") }
	}
}

/**
 * Finds the codepoint in `[first, first + chunk)` that makes the two disagree, to name it in a report.
 */
export function culpritCodepoint(first: number, chunk = 2048): number | null {
	for (let codepoint = first; codepoint < Math.min(first + chunk, 0x11_00_00); codepoint++) {
		const character = String.fromCodePoint(codepoint)

		if ([`a${character}1`, character, `${character}${character}`].some((text) => compareOne(text))) return codepoint
	}

	return null
}
