// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The comparison of the `postcode_legacy` family's `knownFormats` with
 *   `computeQueryShape` of `@mailwoman/query-shape`.
 *
 *   The two return the same list for the same text, on every input: the same formats,
 *   spans, bodies and confidences, in the same order.
 *   The comparison lives here, and not in `@mailwoman/recognize`,
 *   because it imports both `@mailwoman/postcode` and `@mailwoman/query-shape`,
 *   and `recognize` mustn't import the postcode package.
 *
 *   `@mailwoman/postcode` depends on `recognize` and takes `query-shape` as a development dependency.
 *
 *   The test, the real-row tool and the benchmark share this module.
 */

import { mulberry32 } from "@mailwoman/core/random"
import { computeQueryShape } from "@mailwoman/query-shape"
import { createRecognizer } from "@mailwoman/recognize"
import { structure } from "@mailwoman/recognize/structure"

import { postcodeLegacy } from "#recognize/legacy"

/**
 * The composed recognizer the comparison runs.
 */
export const recognizer = createRecognizer([structure, postcodeLegacy])

/**
 * One known-format hit as plain data in a fixed key order.
 */
export interface PlainHit {
	format: string
	span: { start: number; end: number; body: string }
	confidence: number
}

/**
 * The hits `computeQueryShape` returns.
 */
export function legacyHits(text: string): PlainHit[] {
	return computeQueryShape(text).knownFormats.map(({ format, span, confidence }) => ({
		format,
		span: { start: span.start, end: span.end, body: span.body },
		confidence,
	}))
}

/**
 * The hits `recognize` returns with `structure` and `postcode_legacy` composed.
 */
export function recognizedHits(text: string): PlainHit[] {
	return recognizer.recognize(text).fields.knownFormats.map(({ format, span, confidence }) => ({
		format,
		span: { start: span.start, end: span.end, body: span.body },
		confidence,
	}))
}

/**
 * One input on which the two disagree.
 */
export interface KnownFormatsDifference {
	input: string
	legacy: PlainHit[]
	recognized: PlainHit[]
}

/**
 * Compares the two on `text`, and returns the difference or `null`.
 */
export function compareKnownFormats(text: string): KnownFormatsDifference | null {
	const legacy = legacyHits(text)
	const recognized = recognizedHits(text)

	// oxlint-disable-next-line no-restricted-properties -- the comparison needs a canonical text of plain data, and the values are not external input
	return JSON.stringify(legacy) === JSON.stringify(recognized) ? null : { input: text, legacy, recognized }
}

const DIGITS = "0123456789"
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

/**
 * The pieces a generated input is made of: what triggers a legacy pattern, in several cases.
 */
const SHAPES: readonly string[] = [
	// Digit groups of every length from 1 to 10.
	...Array.from({ length: 10 }, (_, index) => DIGITS.slice(0, 1).repeat(index + 1)),
	...Array.from({ length: 10 }, (_, index) => "12345678901".slice(0, index + 1)),
	"68161",
	// Two tokens joined in the text by one space, as the pair patterns read them.
	"123 45",
	"SW1A 1AA",
	"K1A 0B1",
	"1012 AB",
	"W1 1AA",
	"100-0001",
	"123-4567",
	"12345-6789",
	"1234-5678",
	"123-45",
	// The letter and digit shapes of the UK, Canada and the Netherlands.
	"SW1A",
	"1AA",
	"SW1A1AA",
	"M1",
	"1AB",
	"M11AB",
	"EC1A",
	"W1A0AX",
	"K1A",
	"0B1",
	"K1A0B1",
	"K1A0B",
	"1012",
	"AB",
	"1012AB",
	"1012A",
	"123AB",
	"12345",
	"123",
	"45",
	"〒",
	"〒100-0001",
	"〒1000001",
	"〒〒100-0001",
	// Connectors and punctuation between and inside tokens.
	"-",
	"–",
	"'",
	".",
	"/",
	"_",
	"x-y",
	"ſ",
	"K",
	"ſw1a",
	"K1A",
]

/**
 * The PO box leaders in the cases the legacy set compares: lower case, upper case,
 * title case, with and without dots.
 */
const LEADERS: readonly string[] = [
	"po",
	"PO",
	"Po",
	"pO",
	"p.o.",
	"P.O.",
	"p.o",
	"P.O",
	"box",
	"BOX",
	"Box",
	"bp",
	"BP",
	"b.p.",
	"B.P.",
	"b.p",
	"B.P",
	"casilla",
	"CASILLA",
	"apartado",
	"Apartado",
	"p.o.box",
	"po.",
	"b.",
	"BOX1012",
	"box1",
]

/**
 * What sits between pieces: a space, a comma, a tab, a newline, a semicolon,
 * a carriage return, a run of space, and the empty separator.
 */
const SEPARATORS: readonly string[] = [" ", " ", " ", ", ", ",", "\t", "\n", "; ", "\r\n", "  ", "", " - ", ". "]

const WORDS: readonly string[] = ["Main", "St", "NW", "NY", "Berlin", "Praha", "東京", "Москва", "a1", "7b", "N"]

/**
 * `value` repeated `times` times, to weight a draw.
 */
function repeated<T>(times: number, value: T): T[] {
	return Array.from({ length: times }, () => value)
}

/**
 * The kinds of piece, repeated to weight them: nine in twenty are a postcode shape, five a PO box
 * leader, two an ordinary word, two a random letter and digit run, and two a run of one digit.
 */
const PIECE_KINDS: readonly string[] = [
	...repeated(9, "shape"),
	...repeated(5, "leader"),
	...repeated(2, "word"),
	...repeated(2, "run"),
	...repeated(2, "digits"),
]

/**
 * Whether a piece is lower-cased: three pieces in ten.
 */
const CASES: readonly string[] = [...repeated(7, "as written"), ...repeated(3, "lower")]

const ALPHANUMERICS: readonly string[] = [...DIGITS, ...LETTERS]

/**
 * `count` random inputs of up to `maxPieces` pieces drawn from the shapes,
 * the leaders and a few ordinary words.
 */
export function generatedKnownFormatInputs(count: number, seed: number, maxPieces = 6): string[] {
	const random = mulberry32(seed)
	const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!

	const piece = (): string => {
		switch (pick(PIECE_KINDS)) {
			case "shape":
				return pick(SHAPES)
			case "leader":
				return pick(LEADERS)
			case "word":
				return pick(WORDS)
			case "run":
				// A fresh letter and digit run in the length of a postcode.
				return Array.from({ length: 1 + Math.floor(random() * 7) }, () => pick(ALPHANUMERICS)).join("")
			default:
				return pick(ALPHANUMERICS.slice(0, DIGITS.length)).repeat(1 + Math.floor(random() * 10))
		}
	}

	const out: string[] = []

	for (let index = 0; index < count; index++) {
		const pieces = 1 + Math.floor(random() * maxPieces)
		let text = ""

		for (let position = 0; position < pieces; position++) {
			if (position) {
				text += pick(SEPARATORS)
			}

			const part = piece()

			text += pick(CASES) === "lower" ? part.toLowerCase() : part
		}

		out.push(text)
	}

	return out
}
