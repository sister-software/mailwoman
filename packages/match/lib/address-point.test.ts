/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { houseNumberComparison, houseNumberParts, unitComparison, type UnitValue } from "#address-point"

describe("unitComparison", () => {
	const comparison = unitComparison<UnitValue>({ extract: (unit) => unit })
	const label = (a: UnitValue, b: UnitValue) => comparison.levels[comparison.assess(a, b)]?.label

	it("separates the same text, the same identifier written differently, and different identifiers", () => {
		expect(label({ raw: "UNIT 2", identifier: "2" }, { raw: "UNIT 2", identifier: "2" })).toBe("same-text")
		expect(label({ raw: "UNIT 2", identifier: "2" }, { raw: "#2", identifier: "2" })).toBe("same-identifier")
		expect(label({ raw: "UNIT 2", identifier: "2" }, { raw: "UNIT 3", identifier: "3" })).toBe("different")
	})

	it("treats two records without a unit as agreement and one without as its own level", () => {
		expect(label({ raw: null, identifier: null }, { raw: null, identifier: null })).toBe("neither-states")
		expect(label({ raw: null, identifier: null }, { raw: "A", identifier: "a" })).toBe("one-states")
	})
})

describe("houseNumberComparison", () => {
	const comparison = houseNumberComparison<string | null>({ extract: (number) => number })

	const label = (a: string | null, b: string | null) => {
		const level = comparison.assess(a, b)

		return level === -1 ? "missing" : comparison.levels[level]?.label
	}

	it("reads a number's base, suffix and range", () => {
		expect(houseNumberParts("12A")).toEqual({ base: 12, suffix: "A", rangeEnd: null })
		expect(houseNumberParts("12 1/2")).toEqual({ base: 12, suffix: "1/2", rangeEnd: null })
		expect(houseNumberParts("12-14")).toEqual({ base: 12, suffix: "", rangeEnd: 14 })
		expect(houseNumberParts("N123")).toBeNull()
	})

	it("levels a pair by exact number, shared base, range containment or difference", () => {
		expect(label("12", "12")).toBe("exact")
		expect(label("12a", "12A")).toBe("exact")
		expect(label("12", "12A")).toBe("same-base")
		expect(label("13", "12-14")).toBe("in-range")
		expect(label("12", "15")).toBe("different")
		expect(label("N123", "N124")).toBe("different")
		expect(label(null, "12")).toBe("missing")
	})
})
