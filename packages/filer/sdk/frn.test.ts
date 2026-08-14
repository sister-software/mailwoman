/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for {@linkcode toFRN}/{@linkcode isFRN} — the zero-padded 10-digit FRN branded string
 *   (decision 3: NOT the Nexus `Tagged<number>` shape, which silently drops leading zeros).
 */

import { describe, expect, it } from "vitest"

import { isFRN, toFRN } from "./frn.ts"

describe("toFRN", () => {
	it("zero-pads a numeric FRN to 10 digits", () => {
		expect(toFRN(1_753_557)).toBe("0001753557")
	})

	it("zero-pads a numeric string FRN to 10 digits", () => {
		expect(toFRN("1753557")).toBe("0001753557")
	})

	it("passes through an already-10-digit string unchanged", () => {
		expect(toFRN("0001753557")).toBe("0001753557")
	})

	it("returns null for a value with more than 10 digits", () => {
		expect(toFRN("123456789012")).toBeNull()
	})

	it("returns null for a non-numeric string", () => {
		expect(toFRN("not-an-frn")).toBeNull()
	})

	it("returns null for a negative number", () => {
		expect(toFRN(-5)).toBeNull()
	})

	it("returns null for a non-integer number", () => {
		expect(toFRN(1_753_557.5)).toBeNull()
	})
})

describe("isFRN", () => {
	it("rejects a 7-digit string — not zero-padded to 10 chars", () => {
		expect(isFRN("1753557")).toBe(false)
	})

	it("accepts a zero-padded 10-digit string", () => {
		expect(isFRN("0001753557")).toBe(true)
	})

	it("rejects a bare number, even a valid-looking one", () => {
		// The Nexus guard accepted this (parseInt/finite/non-negative only, see
		// isp-nexus/universe/fcc/entity/frn.ts). This port requires the actual 10-char, zero-padded
		// string shape — decision 3 calls the Nexus guard out by name as laxity not to copy.
		expect(isFRN(1_753_557)).toBe(false)
	})

	it("rejects non-digit characters", () => {
		expect(isFRN("000175355A")).toBe(false)
	})

	it("rejects null/undefined", () => {
		expect(isFRN(null)).toBe(false)
		expect(isFRN(undefined)).toBe(false)
	})

	it("rejects an 11-digit string — too long for the zero-padded 10-char shape", () => {
		expect(isFRN("00017535571")).toBe(false)
	})

	it("rejects an empty string", () => {
		expect(isFRN("")).toBe(false)
	})
})
