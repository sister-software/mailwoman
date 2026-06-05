/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import { FR_DEPARTEMENTS } from "./departement.js"
import { FR_REGIONS, isFrenchRegionCode, lookupFrenchRegion } from "./region.js"

describe("FR_REGIONS", () => {
	it("covers all 18 régions (13 metropolitan + 5 overseas)", () => {
		expect(Object.keys(FR_REGIONS)).toHaveLength(18)
		expect(FR_REGIONS.IDF.name).toBe("Île-de-France")
	})
})

describe("FR_DEPARTEMENTS", () => {
	it("covers all 101 départements", () => {
		expect(Object.keys(FR_DEPARTEMENTS)).toHaveLength(101)
	})
	it("every département points at a real région", () => {
		for (const d of Object.values(FR_DEPARTEMENTS)) {
			expect(FR_REGIONS[d.region]).toBeDefined()
		}
	})
})

describe("isFrenchRegionCode", () => {
	it("accepts ISO 3166-2:FR region codes, case-insensitively", () => {
		expect(isFrenchRegionCode("IDF")).toBe(true)
		expect(isFrenchRegionCode("pac")).toBe(true)
		expect(isFrenchRegionCode("BY")).toBe(false) // a German state, not French
	})
})

describe("lookupFrenchRegion", () => {
	it("resolves code and name, accents optional (mirrors lookupGermanState)", () => {
		expect(lookupFrenchRegion("IDF")).toBe("IDF")
		expect(lookupFrenchRegion("Île-de-France")).toBe("IDF")
		expect(lookupFrenchRegion("ile-de-france")).toBe("IDF") // unaccented surface form
		expect(lookupFrenchRegion("Provence-Alpes-Côte d'Azur")).toBe("PAC")
		expect(lookupFrenchRegion("Nouvelle-Aquitaine")).toBe("NAQ")
	})

	it("returns null for an unknown region", () => {
		expect(lookupFrenchRegion("Bavaria")).toBeNull()
		expect(lookupFrenchRegion(null)).toBeNull()
	})
})
