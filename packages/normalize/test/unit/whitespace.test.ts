/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { collapseWhitespace } from "@mailwoman/normalize/whitespace"
import { describe, expect, it } from "vitest"

describe("collapseWhitespace", () => {
	it("leaves single-spaced text unchanged", () => {
		const r = collapseWhitespace("350 5th Ave")
		expect(r.text).toBe("350 5th Ave")
		expect(r.runs).toBe(0)
	})

	it("collapses double spaces to single", () => {
		const r = collapseWhitespace("350  5th Ave")
		expect(r.text).toBe("350 5th Ave")
		expect(r.runs).toBe(1)
	})

	it("collapses many spaces to single", () => {
		const r = collapseWhitespace("350     5th     Ave")
		expect(r.text).toBe("350 5th Ave")
		expect(r.runs).toBe(2)
	})

	it("collapses tabs to single space", () => {
		const r = collapseWhitespace("350\t\t5th")
		expect(r.text).toBe("350 5th")
		expect(r.runs).toBe(1)
	})

	it("normalizes a LONE tab to a space, as it does a doubled one (#1943)", () => {
		const one = collapseWhitespace("350\t5th")
		expect(one.text).toBe("350 5th")
		expect(one.runs).toBe(1)
		expect(one.map).toHaveLength(one.text.length)

		expect(collapseWhitespace("350\t\t5th").text).toBe(one.text)
	})

	it("normalizes a mixed tab/space run to one space", () => {
		expect(collapseWhitespace("350 \t5th").text).toBe("350 5th")
		expect(collapseWhitespace("350\t 5th").text).toBe("350 5th")
		expect(collapseWhitespace("350 \t \t5th").text).toBe("350 5th")
	})

	it("normalizes every tab in a wholly tab-separated line (#1943)", () => {
		const r = collapseWhitespace("Rue\tdu\tFaubourg\tSaint-Honoré")
		expect(r.text).toBe("Rue du Faubourg Saint-Honoré")
		expect(r.runs).toBe(3)
		expect(r.map).toHaveLength(r.text.length)
	})

	it("preserves newlines", () => {
		const r = collapseWhitespace("line 1\nline 2")
		expect(r.text).toBe("line 1\nline 2")
		expect(r.runs).toBe(0)
	})

	it("preserves a newline beside a normalized tab", () => {
		const r = collapseWhitespace("line\t1\nline\t2")
		expect(r.text).toBe("line 1\nline 2")
		expect(r.map).toHaveLength(r.text.length)
	})

	it("trims leading whitespace", () => {
		const r = collapseWhitespace("   350 5th")
		expect(r.text).toBe("350 5th")
	})

	it("trims trailing whitespace", () => {
		const r = collapseWhitespace("350 5th   ")
		expect(r.text).toBe("350 5th")
	})

	it("trims leading and trailing tabs rather than leaving a space behind", () => {
		const r = collapseWhitespace("\t350 5th\t")
		expect(r.text).toBe("350 5th")
		expect(r.map).toEqual([1, 2, 3, 4, 5, 6, 7])
	})

	it("trims trailing sentence-punctuation noise (#829 tail): . , ; :", () => {
		expect(collapseWhitespace("Washington DC.").text).toBe("Washington DC")
		expect(collapseWhitespace("123 Main St., Apt 5;").text).toBe("123 Main St., Apt 5") // internal '.' kept
		expect(collapseWhitespace("Paris . ").text).toBe("Paris") // mixed trailing space + dot
		expect(collapseWhitespace("foo:").text).toBe("foo")
	})

	it("does NOT trim leading punctuation or internal / quote / bracket punctuation", () => {
		expect(collapseWhitespace(".net cafe").text).toBe(".net cafe") // leading dot is load-bearing
		expect(collapseWhitespace('"350 5th"').text).toBe('"350 5th"') // trailing quote is not noise
		expect(collapseWhitespace("Apt (rear)").text).toBe("Apt (rear)") // trailing bracket preserved
	})

	it("offsetMap stays correct + length-matched after a trailing-punct trim", () => {
		const r = collapseWhitespace("ABC.")
		expect(r.text).toBe("ABC")
		expect(r.map).toEqual([0, 1, 2]) // the trailing '.' at index 3 is sliced off
		expect(r.map).toHaveLength(r.text.length)
	})

	it("offsetMap points to first whitespace in collapsed run", () => {
		// raw:  "350  5th Ave"     (positions 0-11, double space at 3,4)
		// out:  "350 5th Ave"      (positions 0-10)
		const r = collapseWhitespace("350  5th Ave")
		expect(r.text).toBe("350 5th Ave")
		expect(r.map[0]).toBe(0) // '3' → 0
		expect(r.map[3]).toBe(3) // ' ' → first space at 3
		expect(r.map[4]).toBe(5) // '5' → 5 (skipped second space at 4)
		expect(r.map.at(-1)).toBe(11) // 'e' → 11
	})

	it("offsetMap correctness after trim", () => {
		const r = collapseWhitespace("   ABC   ")
		expect(r.text).toBe("ABC")
		expect(r.map).toEqual([3, 4, 5])
	})

	it("offsetMap length always matches text length", () => {
		const inputs = ["abc", "  abc  ", "a  b", "abc\ndef"]

		for (const inp of inputs) {
			const r = collapseWhitespace(inp)
			expect(r.map).toHaveLength(r.text.length)
		}
	})
})
