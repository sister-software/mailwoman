/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { firstDigitRegion, isJpPostalCode, normalizeJpPostalCode } from "./postal-code.js"

describe("normalizeJpPostalCode", () => {
	it("strips the 〒 mark and whitespace, keeping the canonical NNN-NNNN", () => {
		expect(normalizeJpPostalCode("〒100-0001")).toBe("100-0001")
		expect(normalizeJpPostalCode(" 100-0001 ")).toBe("100-0001")
		expect(normalizeJpPostalCode("100-0001")).toBe("100-0001")
	})

	it("inserts the hyphen for a bare seven-digit input", () => {
		expect(normalizeJpPostalCode("1000001")).toBe("100-0001")
		expect(normalizeJpPostalCode("〒1000001")).toBe("100-0001")
	})

	it("returns null when the result is not seven digits", () => {
		expect(normalizeJpPostalCode("100-000")).toBeNull() // six digits
		expect(normalizeJpPostalCode("10000012")).toBeNull() // eight digits
		expect(normalizeJpPostalCode("SW1A 1AA")).toBeNull()
		expect(normalizeJpPostalCode(1000001)).toBeNull()
	})
})

describe("isJpPostalCode", () => {
	it("accepts NNN-NNNN with the hyphen optional", () => {
		expect(isJpPostalCode("100-0001")).toBe(true)
		expect(isJpPostalCode("1000001")).toBe(true)
		expect(isJpPostalCode("100-001")).toBe(false) // wrong digit count
		expect(isJpPostalCode("〒100-0001")).toBe(false) // normalize first
	})
})

describe("firstDigitRegion", () => {
	it("maps the leading digit to a coarse routing region", () => {
		expect(firstDigitRegion("100-0001")).toMatch(/Tokyo|Kanto/) // 1xx → Tokyo & Kanto
		expect(firstDigitRegion("〒1000001")).toMatch(/Tokyo|Kanto/) // normalizes first
		expect(firstDigitRegion("0600000")).toMatch(/Hokkaido/) // 0xx → Hokkaido & north
	})

	it("returns null for non-postal-code input", () => {
		expect(firstDigitRegion("nope")).toBeNull()
		expect(firstDigitRegion(null)).toBeNull()
	})
})
