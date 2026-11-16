// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { isScriptCode } from "#iso15924/codes"
import { codePointScript } from "#iso15924/unicode-script"

/**
 * One code point of each script an address is written in, with the Unicode 15 answer.
 *
 * A runtime that assigns these differently has changed the standard, and this test is the place to see it.
 */
const PINNED: ReadonlyArray<readonly [number, string]> = [
	[0x41, "Latn"],
	[0x7a, "Latn"],
	[0xe9, "Latn"],
	[0x1e_00, "Latn"],
	[0xff_21, "Latn"],
	[0x3_b1, "Grek"],
	[0x1f_00, "Grek"],
	[0x4_30, "Cyrl"],
	[0x6_27, "Arab"],
	[0x5_d0, "Hebr"],
	[0x9_05, "Deva"],
	[0x9_95, "Beng"],
	[0xe_01, "Thai"],
	[0x10_d0, "Geor"],
	[0x5_31, "Armn"],
	[0xac_00, "Hang"],
	[0x30_42, "Hira"],
	[0x30_a2, "Kana"],
	[0xff_71, "Kana"],
	[0x4e_2d, "Hani"],
	[0x2_00_00, "Hani"],
	[0xb_85, "Taml"],
	[0x12_00, "Ethi"],
	[0x17_80, "Khmr"],
	[0x10_00, "Mymr"],
	[0xa0_00, "Yiii"],
	[0x31, "Zyyy"],
	[0x2c, "Zyyy"],
	[0x30_01, "Zyyy"],
	[0xff_01, "Zyyy"],
	[0x1_f6_00, "Zyyy"],
	[0x3_01, "Zinh"],
	[0x20_0d, "Zinh"],
	[0x3_78, "Zzzz"],
	[0x10_ff_ff, "Zzzz"],
]

describe("codePointScript", () => {
	it.each(PINNED)("reads U+%s as %s", (codePoint, script) => {
		expect(codePointScript(codePoint)).toBe(script)
	})

	it("answers with a registry script code for every pinned code point", () => {
		for (const [codePoint] of PINNED) {
			expect(isScriptCode(codePointScript(codePoint))).toBe(true)
		}
	})

	it("answers the same for a code point the second time", () => {
		expect(codePointScript(0x3_b1)).toBe(codePointScript(0x3_b1))
	})

	it("reports Latin for the ASCII letters and Common for the rest of ASCII", () => {
		for (let code = 0; code < 0x80; code++) {
			const letter = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)

			expect(codePointScript(code), `U+${code.toString(16)}`).toBe(letter ? "Latn" : "Zyyy")
		}
	})
})
