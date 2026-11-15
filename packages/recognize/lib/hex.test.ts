// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { decodeHex } from "#hex"

describe("decodeHex", () => {
	it("decodes every byte value", () => {
		const text = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, "0")).join("")

		expect(Array.from(decodeHex(text))).toEqual(Array.from({ length: 256 }, (_, value) => value))
		expect(decodeHex("")).toHaveLength(0)
	})

	it("refuses an odd length and a character outside 0-9a-f", () => {
		expect(() => decodeHex("abc")).toThrow(RangeError)
		expect(() => decodeHex("zz")).toThrow(RangeError)
		expect(() => decodeHex("AB")).toThrow(RangeError)
	})
})
