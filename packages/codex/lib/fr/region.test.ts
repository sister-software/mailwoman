// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { FR_DEPARTEMENTS, FR_REGIONS, isFrenchRegionCode, lookupFrenchRegion } from "#fr"

describe("FR_DEPARTEMENTS", () => {
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
		expect(isFrenchRegionCode("BY")).toBe(false) // a German state rather than French
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
