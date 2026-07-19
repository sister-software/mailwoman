/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { getAllBrands, getBrand, lookupPOIBrand, resolveBrandName } from "./brands.ts"

describe("lookupPOIBrand", () => {
	it("matches a real brand by its exact name, case-insensitively", () => {
		const matches = lookupPOIBrand("chevron")
		expect(matches[0]?.brand.wikidata).toBe("Q319642")
		expect(matches[0]?.brand.name).toBe("Chevron")
		expect(matches[0]?.confidence).toBe(1.0)
	})

	it("matches a known alias variant", () => {
		const [target] = getAllBrands().filter((b) => b.aliases.length > 0)
		expect(target, "expected at least one committed brand with aliases").toBeDefined()

		const alias = target!.aliases[0]!
		const matches = lookupPOIBrand(alias)
		expect(matches.some((m) => m.brand.wikidata === target!.wikidata)).toBe(true)
		expect(matches.find((m) => m.brand.wikidata === target!.wikidata)?.matchedPhrase).toBe(alias)
	})

	it("returns [] for unknown phrases", () => {
		expect(lookupPOIBrand("flux capacitor depot")).toEqual([])
	})

	it("returns [] for blank input", () => {
		expect(lookupPOIBrand("   ")).toEqual([])
	})
})

describe("resolveBrandName", () => {
	it("returns the single best brand for an exact match", () => {
		expect(resolveBrandName("Chevron")?.wikidata).toBe("Q319642")
	})

	it("returns undefined for an unknown name", () => {
		expect(resolveBrandName("flux capacitor depot")).toBeUndefined()
	})
})

describe("getBrand / getAllBrands", () => {
	it("fetches a brand by its wikidata QID", () => {
		expect(getBrand("Q319642")?.name).toBe("Chevron")
		expect(getBrand("Q999999999")).toBeUndefined()
	})

	it("enumerates every committed brand", () => {
		const all = getAllBrands()
		expect(all.length).toBeGreaterThan(0)
		expect(all.every((b) => b.rows > 0)).toBe(true)
	})
})

describe("brand table integrity", () => {
	it("every brand carries a well-formed Wikidata QID and a non-empty name", () => {
		for (const brand of getAllBrands()) {
			expect(brand.wikidata, `malformed QID on ${JSON.stringify(brand)}`).toMatch(/^Q\d+$/)
			expect(brand.name.length, `empty name on ${brand.wikidata}`).toBeGreaterThan(0)
		}
	})

	it("wikidata QIDs are unique", () => {
		const ids = getAllBrands().map((b) => b.wikidata)
		expect(new Set(ids).size).toBe(ids.length)
	})

	it("is sorted by rows descending", () => {
		const rows = getAllBrands().map((b) => b.rows)

		for (let i = 1; i < rows.length; i++) {
			expect(rows[i]!).toBeLessThanOrEqual(rows[i - 1]!)
		}
	})

	it("every brand clears the generator's committed min-rows floor", () => {
		for (const brand of getAllBrands()) {
			expect(brand.rows).toBeGreaterThanOrEqual(25)
		}
	})
})
