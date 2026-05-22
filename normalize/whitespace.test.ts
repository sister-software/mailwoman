/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import { collapseWhitespace } from "./whitespace.js"

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

	it("preserves newlines", () => {
		const r = collapseWhitespace("line 1\nline 2")
		expect(r.text).toBe("line 1\nline 2")
	})

	it("trims leading whitespace", () => {
		const r = collapseWhitespace("   350 5th")
		expect(r.text).toBe("350 5th")
	})

	it("trims trailing whitespace", () => {
		const r = collapseWhitespace("350 5th   ")
		expect(r.text).toBe("350 5th")
	})

	it("offsetMap points to first whitespace in collapsed run", () => {
		// raw:  "350  5th Ave"     (positions 0-11, double space at 3,4)
		// out:  "350 5th Ave"      (positions 0-10)
		const r = collapseWhitespace("350  5th Ave")
		expect(r.text).toBe("350 5th Ave")
		expect(r.map[0]).toBe(0) // '3' → 0
		expect(r.map[3]).toBe(3) // ' ' → first space at 3
		expect(r.map[4]).toBe(5) // '5' → 5 (skipped second space at 4)
		expect(r.map[r.map.length - 1]).toBe(11) // 'e' → 11
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
			expect(r.map.length).toBe(r.text.length)
		}
	})
})
