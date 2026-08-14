/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { isNZPostcode, normalizeNZPostcode, NZ_POSTCODE_PATTERN } from "./postcode.ts"

test("NZ_POSTCODE_PATTERN: matches exactly four digits, nothing else", () => {
	expect(NZ_POSTCODE_PATTERN.test("7942")).toBe(true)
	expect(NZ_POSTCODE_PATTERN.test("0110")).toBe(true) // leading zero
	expect(NZ_POSTCODE_PATTERN.test("794")).toBe(false) // too short
	expect(NZ_POSTCODE_PATTERN.test("79420")).toBe(false) // too long
	expect(NZ_POSTCODE_PATTERN.test("79A2")).toBe(false) // letters
	expect(NZ_POSTCODE_PATTERN.test(" 7942")).toBe(false) // pattern does not tolerate whitespace
})

test("normalizeNZPostcode: trims and returns a valid four-digit postcode", () => {
	expect(normalizeNZPostcode("7942")).toBe("7942")
	expect(normalizeNZPostcode("  6011  ")).toBe("6011") // trim
	expect(normalizeNZPostcode("\t0110\n")).toBe("0110")
	expect(normalizeNZPostcode("0110")).toBe("0110") // leading zero preserved
})

test("normalizeNZPostcode: rejects wrong-shape / non-string → null", () => {
	expect(normalizeNZPostcode("794")).toBeNull()
	expect(normalizeNZPostcode("79420")).toBeNull()
	expect(normalizeNZPostcode("Auckland")).toBeNull()
	expect(normalizeNZPostcode("79 42")).toBeNull() // interior space
	expect(normalizeNZPostcode("")).toBeNull()
	expect(normalizeNZPostcode("   ")).toBeNull()
	expect(normalizeNZPostcode(7942)).toBeNull() // number, not string
	expect(normalizeNZPostcode(null)).toBeNull()
	expect(normalizeNZPostcode(undefined)).toBeNull()
})

test("isNZPostcode: predicate is true only for an already-normalized four-digit string", () => {
	expect(isNZPostcode("7942")).toBe(true)
	expect(isNZPostcode("0110")).toBe(true)
	// the predicate does NOT trim — it tests the shape verbatim
	expect(isNZPostcode(" 7942 ")).toBe(false)
	expect(isNZPostcode("794")).toBe(false)
	expect(isNZPostcode("ABCD")).toBe(false)
	expect(isNZPostcode("")).toBe(false)
	expect(isNZPostcode(7942)).toBe(false)
	expect(isNZPostcode(null)).toBe(false)
	expect(isNZPostcode(undefined)).toBe(false)
})

test("normalizeNZPostcode → isNZPostcode round-trip: a normalized value passes the predicate", () => {
	const normalized = normalizeNZPostcode("  7942  ")
	expect(normalized).not.toBeNull()
	expect(isNZPostcode(normalized)).toBe(true)
})
