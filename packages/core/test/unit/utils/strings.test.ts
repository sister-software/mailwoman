/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { compareByCodePoint, escapeRegExp } from "@mailwoman/core/utils"
import { describe, expect, it } from "vitest"

describe("escapeRegExp", () => {
	it("makes a literal match itself and nothing else", () => {
		const literal = "1.0.0+build(2)?[x]\\"
		const pattern = new RegExp(`^${escapeRegExp(literal)}$`)

		expect(pattern.test(literal)).toBe(true)
		expect(pattern.test("1a0b0+build(2)?[x]\\")).toBe(false)
	})
})

describe("compareByCodePoint", () => {
	it("orders by code point, not by locale", () => {
		expect(["b", "a", "B", "é"].toSorted(compareByCodePoint)).toEqual(["B", "a", "b", "é"])
		expect(compareByCodePoint("same", "same")).toBe(0)
	})
})
