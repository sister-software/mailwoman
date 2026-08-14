/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { matchSubdivision } from "./subdivision.ts"

describe("matchSubdivision", () => {
	it("expands a CA province abbreviation to its name + country (the Montreal QC path)", () => {
		expect(matchSubdivision("QC")).toEqual({ code: "QC", name: "Quebec", country: "CA" })
		expect(matchSubdivision("ON")).toEqual({ code: "ON", name: "Ontario", country: "CA" })
		expect(matchSubdivision("bc")).toEqual({ code: "BC", name: "British Columbia", country: "CA" })
	})

	it("resolves CA province full names, English and co-official French, accents optional", () => {
		expect(matchSubdivision("Quebec")?.country).toBe("CA")
		expect(matchSubdivision("Québec")?.code).toBe("QC")
		expect(matchSubdivision("Colombie-Britannique")?.code).toBe("BC")
		expect(matchSubdivision("Nouvelle-Ecosse")?.code).toBe("NS")
	})

	it("resolves US states by abbreviation and by name", () => {
		expect(matchSubdivision("IL")).toEqual({ code: "IL", name: "Illinois", country: "US" })
		expect(matchSubdivision("ME")).toEqual({ code: "ME", name: "Maine", country: "US" })
		expect(matchSubdivision("Illinois")?.country).toBe("US")
	})

	it("resolves 'CA' to California the US state, never Canada the country", () => {
		expect(matchSubdivision("CA")).toEqual({ code: "CA", name: "California", country: "US" })
	})

	it("is case- and diacritic-insensitive", () => {
		expect(matchSubdivision("qc")?.code).toBe("QC")
		expect(matchSubdivision("  Ontario  ")?.code).toBe("ON")
	})

	it("returns null for a bare country token or an unknown subdivision", () => {
		expect(matchSubdivision("Canada")).toBeNull()
		expect(matchSubdivision("Bavaria")).toBeNull()
		expect(matchSubdivision("")).toBeNull()
		expect(matchSubdivision(null)).toBeNull()
		expect(matchSubdivision(undefined)).toBeNull()
	})
})
