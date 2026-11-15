// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The byte-to-UTF-16 mapping on astral symbols, combining marks, CJK and mixed-script text.
 *
 *   Each case checks every boundary against an independent construction from `Array.from`,
 *   and that every offset inside a codepoint is refused.
 */

import { describe, expect, it } from "vitest"

import { offsetMap } from "#offsets"

const encoder = new TextEncoder()

/**
 * The byte and code-unit offset of each codepoint boundary, built from codepoint iteration.
 */
function boundaries(text: string): Array<[byte: number, unit: number]> {
	const out: Array<[number, number]> = [[0, 0]]
	let byte = 0
	let unit = 0

	for (const codepoint of Array.from(text)) {
		byte += encoder.encode(codepoint).length
		unit += codepoint.length
		out.push([byte, unit])
	}

	return out
}

const CASES: Record<string, string> = {
	ascii: "12 Main St",
	"astral symbols": "a😀b𠮷c",
	"combining marks": "éạ̈x",
	CJK: "〒100-0001 東京都千代田区千代田1-1",
	"mixed script": "金龍酒家, 12 Gerrard Street, London WC2H 7JS, Москва, مدينة",
	"lone surrogates": "a\uD800b\uDC00c",
	empty: "",
}

describe("offsetMap", () => {
	for (const [name, text] of Object.entries(CASES)) {
		it(`maps every codepoint boundary of ${name} and refuses every other offset`, () => {
			const bytes = encoder.encode(text).length
			const map = offsetMap(text, bytes)
			const known = new Map(boundaries(text))

			for (let byte = 0; byte <= bytes; byte++) {
				if (known.has(byte)) {
					expect(map.toUTF16(byte)).toBe(known.get(byte))
				} else {
					expect(() => map.toUTF16(byte)).toThrow(RangeError)
				}
			}

			expect(() => map.toUTF16(bytes + 1)).toThrow(RangeError)
			expect(() => map.toUTF16(-1)).toThrow(RangeError)
		})
	}

	it("slices a span at the right place when the text has wide codepoints before it", () => {
		const text = "😀😀 12.5, 7"
		const bytes = encoder.encode(text).length
		const map = offsetMap(text, bytes)
		const start = encoder.encode("😀😀 ").length
		const end = encoder.encode("😀😀 12.5, 7").length

		expect(text.slice(map.toUTF16(start), map.toUTF16(end))).toBe("12.5, 7")
	})

	it("rejects an encoded length the text does not have", () => {
		expect(() => offsetMap("é", 5)).toThrow(RangeError)
	})
})
