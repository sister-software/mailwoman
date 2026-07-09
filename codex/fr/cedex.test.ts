/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { isCedex, matchCedex } from "./cedex.ts"

describe("matchCedex", () => {
	it("matches the canonical terminal phrase with office number", () => {
		expect(matchCedex("75008 PARIS CEDEX 08")).toMatchObject({ matched: "CEDEX 08", start: 12, office: "08" })
	})

	it("matches bare CEDEX without an office number", () => {
		expect(matchCedex("23130 SAINT-LOUP Cedex")).toMatchObject({ matched: "Cedex" })
		expect(matchCedex("23130 SAINT-LOUP Cedex")?.office).toBeUndefined()
	})

	it("is case-insensitive and returns the LAST occurrence", () => {
		const m = matchCedex("Cedex Imprimerie, 59100 ROUBAIX CEDEX 13")
		expect(m).toMatchObject({ matched: "CEDEX 13", office: "13" })
	})

	it("does not claim digit runs longer than two as the office", () => {
		// "CEDEX 123": the trailing \b cannot land inside a digit run, so the optional office
		// group backtracks away entirely — bare CEDEX matches and "123" stays unclaimed (a
		// three-digit number is not a cedex office; this is the desired behavior).
		const m = matchCedex("PARIS CEDEX 123")
		expect(m?.matched).toBe("CEDEX")
		expect(m?.office).toBeUndefined()
	})

	it("returns null when absent", () => {
		expect(matchCedex("75008 Paris")).toBeNull()
	})
})

describe("isCedex", () => {
	it("accepts exact component values", () => {
		expect(isCedex("CEDEX 08")).toBe(true)
		expect(isCedex("Cedex 4")).toBe(true)
		expect(isCedex("CEDEX")).toBe(true)
	})

	it("rejects embedded or non-cedex strings", () => {
		expect(isCedex("PARIS CEDEX 08")).toBe(false)
		expect(isCedex("75008")).toBe(false)
		expect(isCedex(42)).toBe(false)
	})
})
