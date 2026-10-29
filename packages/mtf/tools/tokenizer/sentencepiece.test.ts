/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { csvRow } from "./sentencepiece.ts"

describe("csvRow", () => {
	it("quotes the entries Python's csv writer quotes", () => {
		expect(csvRow(["a.txt", "b.txt"])).toBe("a.txt,b.txt")
		expect(csvRow([",", 'say "hi"', "x"])).toBe('",","say ""hi""",x')
		expect(csvRow([""])).toBe('""')
	})
})
