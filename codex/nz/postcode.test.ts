/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { isNzPostcode, normalizeNzPostcode, NZ_POSTCODE_PATTERN } from "./postcode.js"

test("NZ_POSTCODE_PATTERN: matches exactly four digits, nothing else", () => {
	expect(NZ_POSTCODE_PATTERN.test("7942")).toBe(true)
	expect(NZ_POSTCODE_PATTERN.test("0110")).toBe(true) // leading zero
	expect(NZ_POSTCODE_PATTERN.test("794")).toBe(false) // too short
	expect(NZ_POSTCODE_PATTERN.test("79420")).toBe(false) // too long
	expect(NZ_POSTCODE_PATTERN.test("79A2")).toBe(false) // letters
	expect(NZ_POSTCODE_PATTERN.test(" 7942")).toBe(false) // pattern does not tolerate whitespace
})

test("normalizeNzPostcode: trims and returns a valid four-digit postcode", () => {
	expect(normalizeNzPostcode("7942")).toBe("7942")
	expect(normalizeNzPostcode("  6011  ")).toBe("6011") // trim
	expect(normalizeNzPostcode("\t0110\n")).toBe("0110")
	expect(normalizeNzPostcode("0110")).toBe("0110") // leading zero preserved
})

test("normalizeNzPostcode: rejects wrong-shape / non-string → null", () => {
	expect(normalizeNzPostcode("794")).toBeNull()
	expect(normalizeNzPostcode("79420")).toBeNull()
	expect(normalizeNzPostcode("Auckland")).toBeNull()
	expect(normalizeNzPostcode("79 42")).toBeNull() // interior space
	expect(normalizeNzPostcode("")).toBeNull()
	expect(normalizeNzPostcode("   ")).toBeNull()
	expect(normalizeNzPostcode(7942)).toBeNull() // number, not string
	expect(normalizeNzPostcode(null)).toBeNull()
	expect(normalizeNzPostcode(undefined)).toBeNull()
})

test("isNzPostcode: predicate is true only for an already-normalized four-digit string", () => {
	expect(isNzPostcode("7942")).toBe(true)
	expect(isNzPostcode("0110")).toBe(true)
	// the predicate does NOT trim — it tests the shape verbatim
	expect(isNzPostcode(" 7942 ")).toBe(false)
	expect(isNzPostcode("794")).toBe(false)
	expect(isNzPostcode("ABCD")).toBe(false)
	expect(isNzPostcode("")).toBe(false)
	expect(isNzPostcode(7942)).toBe(false)
	expect(isNzPostcode(null)).toBe(false)
	expect(isNzPostcode(undefined)).toBe(false)
})

test("normalizeNzPostcode → isNzPostcode round-trip: a normalized value passes the predicate", () => {
	const normalized = normalizeNzPostcode("  7942  ")
	expect(normalized).not.toBeNull()
	expect(isNzPostcode(normalized)).toBe(true)
})
