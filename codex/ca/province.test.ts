/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { CA_PROVINCES, isCanadianProvinceCode, lookupCanadianProvince } from "./province.js"

describe("CA_PROVINCES", () => {
	it("covers all 13 provinces and territories", () => {
		expect(Object.keys(CA_PROVINCES)).toHaveLength(13)
		expect(CA_PROVINCES.QC).toEqual({ code: "QC", name: "Quebec", french: "Québec" })
		expect(CA_PROVINCES.BC.french).toBe("Colombie-Britannique")
	})
})

describe("isCanadianProvinceCode", () => {
	it("accepts ISO 3166-2:CA codes, case-insensitively", () => {
		expect(isCanadianProvinceCode("QC")).toBe(true)
		expect(isCanadianProvinceCode("on")).toBe(true)
		expect(isCanadianProvinceCode("CA")).toBe(false) // a US state, not a Canadian subdivision
	})
})

describe("lookupCanadianProvince", () => {
	it("resolves code, English name, and French name, accents optional", () => {
		expect(lookupCanadianProvince("QC")).toBe("QC")
		expect(lookupCanadianProvince("Quebec")).toBe("QC")
		expect(lookupCanadianProvince("Québec")).toBe("QC") // co-official French form, accented
		expect(lookupCanadianProvince("Colombie-Britannique")).toBe("BC")
		expect(lookupCanadianProvince("British Columbia")).toBe("BC")
		expect(lookupCanadianProvince("Nouvelle-Ecosse")).toBe("NS") // unaccented French surface form
		expect(lookupCanadianProvince("Newfoundland and Labrador")).toBe("NL")
	})

	it("returns null for an unknown subdivision", () => {
		expect(lookupCanadianProvince("Bavaria")).toBeNull()
		expect(lookupCanadianProvince(null)).toBeNull()
	})
})
