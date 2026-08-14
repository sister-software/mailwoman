/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { AU_POSTCODE_PATTERN, isAuPostcode, normalizeAuPostcode } from "./postcode.ts"

test("AU_POSTCODE_PATTERN: matches exactly four digits, nothing else", () => {
	expect(AU_POSTCODE_PATTERN.test("2000")).toBe(true)
	expect(AU_POSTCODE_PATTERN.test("0800")).toBe(true) // NT leading zero
	expect(AU_POSTCODE_PATTERN.test("200")).toBe(false) // too short
	expect(AU_POSTCODE_PATTERN.test("20000")).toBe(false) // too long
	expect(AU_POSTCODE_PATTERN.test("20A0")).toBe(false) // letters
	expect(AU_POSTCODE_PATTERN.test(" 2000")).toBe(false) // pattern itself does not tolerate whitespace
})

test("normalizeAuPostcode: trims and returns a valid four-digit postcode", () => {
	expect(normalizeAuPostcode("2000")).toBe("2000")
	expect(normalizeAuPostcode("  6230  ")).toBe("6230") // trim
	expect(normalizeAuPostcode("\t3664\n")).toBe("3664")
	expect(normalizeAuPostcode("0800")).toBe("0800") // leading zero preserved
})

test("normalizeAuPostcode: rejects wrong-shape / non-string → null", () => {
	expect(normalizeAuPostcode("200")).toBeNull()
	expect(normalizeAuPostcode("20000")).toBeNull()
	expect(normalizeAuPostcode("NSW")).toBeNull()
	expect(normalizeAuPostcode("20 00")).toBeNull() // interior space
	expect(normalizeAuPostcode("")).toBeNull()
	expect(normalizeAuPostcode("   ")).toBeNull()
	expect(normalizeAuPostcode(2000)).toBeNull() // number, not string
	expect(normalizeAuPostcode(null)).toBeNull()
	expect(normalizeAuPostcode(undefined)).toBeNull()
})

test("isAuPostcode: predicate is true only for an already-normalized four-digit string", () => {
	expect(isAuPostcode("2000")).toBe(true)
	expect(isAuPostcode("0800")).toBe(true)
	// the predicate does NOT trim — it tests the shape verbatim
	expect(isAuPostcode(" 2000 ")).toBe(false)
	expect(isAuPostcode("200")).toBe(false)
	expect(isAuPostcode("ABCD")).toBe(false)
	expect(isAuPostcode("")).toBe(false)
	expect(isAuPostcode(2000)).toBe(false)
	expect(isAuPostcode(null)).toBe(false)
	expect(isAuPostcode(undefined)).toBe(false)
})

test("normalizeAuPostcode → isAuPostcode round-trip: a normalized value passes the predicate", () => {
	const normalized = normalizeAuPostcode("  2000  ")
	expect(normalized).not.toBeNull()
	expect(isAuPostcode(normalized)).toBe(true)
})
