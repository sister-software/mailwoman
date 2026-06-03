/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import { isCaPostalCode, isRuralPostalCode, normalizeCaPostalCode, provinceOfPostalCode } from "./postal-code.js"

describe("normalizeCaPostalCode", () => {
	it("uppercases and inserts a single space between FSA and LDU", () => {
		expect(normalizeCaPostalCode("K1A0B1")).toBe("K1A 0B1")
		expect(normalizeCaPostalCode("k1a 0b1")).toBe("K1A 0B1")
		expect(normalizeCaPostalCode(" m5v2t6 ")).toBe("M5V 2T6")
	})
	it("returns null for non-codes", () => {
		expect(normalizeCaPostalCode("K1A 0B")).toBeNull() // too short
		expect(normalizeCaPostalCode("D1A 0B1")).toBeNull() // D never opens a postcode
		expect(normalizeCaPostalCode("75008")).toBeNull() // a French code postal
		expect(normalizeCaPostalCode(12345)).toBeNull()
	})
})

describe("isCaPostalCode", () => {
	it("accepts the spaced or unspaced surface form, rejects bad letters", () => {
		expect(isCaPostalCode("K1A 0B1")).toBe(true)
		expect(isCaPostalCode("K1A0B1")).toBe(true)
		expect(isCaPostalCode("Z1A 0B1")).toBe(false) // Z never opens a postcode
	})
})

describe("provinceOfPostalCode — the FSA-letter → province prior", () => {
	it("maps the clean single-province letters", () => {
		expect(provinceOfPostalCode("M5V 2T6")).toBe("ON") // Toronto
		expect(provinceOfPostalCode("H2X 1Y4")).toBe("QC") // Montreal
		expect(provinceOfPostalCode("V6B 1A1")).toBe("BC") // Vancouver
		expect(provinceOfPostalCode("T2P 1J9")).toBe("AB") // Calgary
	})

	it("returns the shared NT/NU pair for the X letter", () => {
		expect(provinceOfPostalCode("X0A 0H0")).toEqual(["NT", "NU"])
	})

	it("returns null for an invalid postal code", () => {
		expect(provinceOfPostalCode("D1A 0B1")).toBeNull()
		expect(provinceOfPostalCode("nope")).toBeNull()
	})
})

describe("isRuralPostalCode — second character is 0", () => {
	it("flags rural FSAs (first digit 0) and not urban ones", () => {
		expect(isRuralPostalCode("X0A 0H0")).toBe(true) // rural northern
		expect(isRuralPostalCode("A0A 1A0")).toBe(true) // rural Newfoundland
		expect(isRuralPostalCode("M5V 2T6")).toBe(false) // urban Toronto
		expect(isRuralPostalCode("H2X 1Y4")).toBe(false) // urban Montreal
	})
	it("returns false for a non-code", () => {
		expect(isRuralPostalCode("nope")).toBe(false)
	})
})
