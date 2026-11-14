// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import { impliedScript, parseLanguageTag } from "#bcp47/tag"
import { ParseFailure } from "#errors"

function canonical(input: string): string | null {
	const parsed = parseLanguageTag(input)

	return parsed.ok ? parsed.value.tag : null
}

describe("parseLanguageTag", () => {
	test.each([
		["en-us", "en-US"],
		["JA-JPAN-JP", "ja-Jpan-JP"],
		["zh-Hans-CN", "zh-Hans-CN"],
		// An extlang is replaced by its preferred value.
		["zh-yue", "yue"],
		// A redundant tag with a preferred value.
		["zh-cmn-Hans", "cmn-Hans"],
		// A deprecated language and a deprecated region take their preferred values.
		["iw", "he"],
		["my-BU", "my-MM"],
		// A grandfathered tag with a preferred value.
		["i-klingon", "tlh"],
		// A UN M49 region and a variant.
		["es-419", "es-419"],
		["sl-rozaj-biske", "sl-rozaj-biske"],
		// Extensions are ordered by singleton, and private use stays last.
		["en-u-ca-gregory-a-xyz-x-mine", "en-a-xyz-u-ca-gregory-x-mine"],
		["qaa", "qaa"],
	])("%s canonicalizes to %s", (input, expected) => {
		expect(canonical(input)).toBe(expected)
	})

	test.each([
		["", ParseFailure.Shape, undefined],
		["en--US", ParseFailure.Shape, undefined],
		["toolongsubtag", ParseFailure.Shape, undefined],
		["en-a", ParseFailure.Shape, "a"],
		// `qqq` sits in the private-use range `qaa..qtz`; the two-letter `qq` is unassigned.
		["qq-US", ParseFailure.NotFound, "qq"],
		["ja-Xyzw", ParseFailure.NotFound, "xyzw"],
		["en-zzz", ParseFailure.NotFound, "zzz"],
		["sl-rozaj-rozaj", ParseFailure.NotFound, "rozaj"],
	])("%j is refused as %s", (input, reason, part) => {
		const parsed = parseLanguageTag(input)

		expect(parsed.ok).toBe(false)

		if (!parsed.ok) {
			expect(parsed.reason).toBe(reason)
			expect(parsed.part).toBe(part)
		}
	})

	test("the implied script reads the explicit subtag, then the language's suppressed script", () => {
		const read = (input: string): string | null => {
			const parsed = parseLanguageTag(input)

			return parsed.ok ? impliedScript(parsed.value) : null
		}

		expect(read("ja")).toBe("Jpan")
		expect(read("ja-Latn")).toBe("Latn")
		expect(read("en-GB")).toBe("Latn")
		expect(read("zh")).toBeNull()
	})
})
