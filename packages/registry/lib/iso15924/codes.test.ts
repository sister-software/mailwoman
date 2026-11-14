// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import { ParseFailure } from "#errors"
import { getScript, isWrittenInScript, parseScriptCode, unicodeScriptsOf } from "#iso15924/codes"
import type { BCP47 } from "#types"

const code = (value: string): BCP47.ScriptCode => value as BCP47.ScriptCode

describe("script codes", () => {
	test("a combined code expands to the Unicode scripts it covers", () => {
		expect(unicodeScriptsOf(code("Jpan"))).toEqual(["Hani", "Hira", "Kana"])
		expect(unicodeScriptsOf(code("Latn"))).toEqual(["Latn"])
		expect(unicodeScriptsOf(code("Zmth"))).toEqual([])
	})

	test("parse distinguishes case from absence", () => {
		expect(parseScriptCode("latn")).toMatchObject({ ok: false, reason: ParseFailure.Case })
		expect(parseScriptCode("Xyzw")).toMatchObject({ ok: false, reason: ParseFailure.NotFound })
		expect(parseScriptCode("Qaab")).toMatchObject({ ok: true })
		expect(getScript("Hans")?.name).toBe("Han (Simplified variant)")
	})

	test.each([
		["ニューヨーク州ブルックリン区", "Jpan", true],
		["ニューヨーク", "Jpan", true],
		["纽约市", "Hans", true],
		["서울특별시 종로구 청운동 52-1", "Kore", true],
		["New York", "Jpan", false],
		["金龍酒家, 12 Gerrard Street", "Latn", false],
		["10001", "Latn", false],
	])("%s written in %s is %s", (text, script, expected) => {
		expect(isWrittenInScript(text, code(script))).toBe(expected)
	})
})
