/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { compareByCodePoint } from "@mailwoman/core/strings/compare"
import { describe, expect, it } from "vitest"

describe("compareByCodePoint", () => {
	it("orders by code point, not by locale", () => {
		expect(["b", "a", "B", "é"].toSorted(compareByCodePoint)).toEqual(["B", "a", "b", "é"])
		expect(compareByCodePoint("same", "same")).toBe(0)
	})
})
