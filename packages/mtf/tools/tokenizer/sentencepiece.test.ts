// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { csvRow } from "./sentencepiece.ts"

describe("csvRow", () => {
	it("quotes the entries Python's csv writer quotes", () => {
		expect(csvRow(["a.txt", "b.txt"])).toBe("a.txt,b.txt")
		expect(csvRow([",", 'say "hi"', "x"])).toBe('",","say ""hi""",x')
		expect(csvRow([""])).toBe('""')
	})
})
