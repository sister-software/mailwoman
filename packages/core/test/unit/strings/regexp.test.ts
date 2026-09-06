// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { escapeRegExp } from "@mailwoman/core/strings/regexp"
import { describe, expect, it } from "vitest"

describe("escapeRegExp", () => {
	it("makes a literal match itself and nothing else", () => {
		const literal = "1.0.0+build(2)?[x]\\"
		const pattern = new RegExp(`^${escapeRegExp(literal)}$`)

		expect(pattern.test(literal)).toBe(true)
		expect(pattern.test("1a0b0+build(2)?[x]\\")).toBe(false)
	})
})
