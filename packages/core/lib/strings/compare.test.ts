/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { compareByCodePoint, compareByScalarValue } from "#strings/compare"

describe("compareByCodePoint", () => {
	it("orders by code unit, independent of locale", () => {
		expect(["b", "a", "B", "é"].toSorted(compareByCodePoint)).toEqual(["B", "a", "b", "é"])
		expect(compareByCodePoint("same", "same")).toBe(0)
		expect(["＆", "𨦻"].toSorted(compareByCodePoint)).toEqual(["𨦻", "＆"])
	})
})

describe("compareByScalarValue", () => {
	it("orders as Python's sorted does, a supplementary-plane character after U+FF06", () => {
		expect(["𨦻", "＆", "b", "a", "B"].toSorted(compareByScalarValue)).toEqual(["B", "a", "b", "＆", "𨦻"])
		expect(["ab", "a", "ａ𨦻", "ａ＆"].toSorted(compareByScalarValue)).toEqual(["a", "ab", "ａ＆", "ａ𨦻"])
		expect(compareByScalarValue("same", "same")).toBe(0)
	})
})
