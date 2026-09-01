/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { clamp, pyFixed, pyFloat, pyRound } from "@mailwoman/core/numeric"
import { describe, expect, it } from "vitest"

describe("clamp", () => {
	it("keeps a value inside the closed interval", () => {
		expect(clamp(5, 0, 10)).toBe(5)
		expect(clamp(-1, 0, 10)).toBe(0)
		expect(clamp(11, 0, 10)).toBe(10)
		expect(clamp(0, 0, 0)).toBe(0)
	})
})

describe("python compatibility", () => {
	it("pyRound rounds half to even, like python's round()", () => {
		expect(pyRound(2.5)).toBe(2)
		expect(pyRound(3.5)).toBe(4)
	})

	it("pyFloat rejects what python's float() rejects", () => {
		expect(pyFloat("3.14")).toBe(3.14)
		expect(pyFloat("not-a-number")).toBeNull()
	})

	it("pyFixed formats like python's format(x, 'f')", () => {
		expect(pyFixed(1.5, 1)).toBe("1.5")
		expect(pyFixed(1, 2)).toBe("1.00")
	})
})
