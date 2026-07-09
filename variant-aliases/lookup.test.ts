/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { getAllAliases, lookupVariantAliases } from "./lookup.ts"

describe("lookupVariantAliases", () => {
	it("exact locale match — Australian 'servo' in en-AU", () => {
		const r = lookupVariantAliases("servo", "en-AU")
		expect(r).toHaveLength(1)
		expect(r[0]!.confidence).toBe(1.0)
		expect(r[0]!.alias.kind).toBe("amenity")

		if (r[0]!.alias.kind === "amenity") {
			expect(r[0]!.alias.category).toBe("fuel")
		}
	})

	it("language match — 'servo' in en-NZ matches both en-AU and en-NZ", () => {
		const r = lookupVariantAliases("servo", "en-NZ")
		expect(r).toHaveLength(1)
		expect(r[0]!.confidence).toBe(1.0)
	})

	it("language fallback — 'servo' in en-IE matches en-AU at lower confidence", () => {
		const r = lookupVariantAliases("servo", "en-IE")
		expect(r).toHaveLength(1)
		expect(r[0]!.confidence).toBe(0.5)
	})

	it("no match — 'servo' in fr-FR", () => {
		expect(lookupVariantAliases("servo", "fr-FR")).toEqual([])
	})

	it("Japanese brand — マクド in ja-JP → McDonald's", () => {
		const r = lookupVariantAliases("マクド", "ja-JP")
		expect(r).toHaveLength(1)
		expect(r[0]!.alias.kind).toBe("brand")

		if (r[0]!.alias.kind === "brand") {
			expect(r[0]!.alias.brand).toBe("McDonald's")
		}
	})

	it("case insensitive — 'SERVO' matches 'servo'", () => {
		const r = lookupVariantAliases("SERVO", "en-AU")
		expect(r).toHaveLength(1)
	})

	it("trim whitespace", () => {
		const r = lookupVariantAliases("  servo  ", "en-AU")
		expect(r).toHaveLength(1)
	})

	it("empty input", () => {
		expect(lookupVariantAliases("", "en-AU")).toEqual([])
		expect(lookupVariantAliases("   ", "en-AU")).toEqual([])
	})

	it("multi-locale variant — 'petrol station' in en-AU, en-GB, en-ZA all match", () => {
		expect(lookupVariantAliases("petrol station", "en-AU")[0]!.confidence).toBe(1.0)
		expect(lookupVariantAliases("petrol station", "en-GB")[0]!.confidence).toBe(1.0)
		expect(lookupVariantAliases("petrol station", "en-ZA")[0]!.confidence).toBe(1.0)
	})

	it("PFK in Quebec → KFC", () => {
		const r = lookupVariantAliases("pfk", "fr-CA")
		expect(r).toHaveLength(1)

		if (r[0]!.alias.kind === "brand") {
			expect(r[0]!.alias.brand).toBe("KFC")
		}
	})

	it("getAllAliases returns non-empty table", () => {
		const all = getAllAliases()
		expect(all.length).toBeGreaterThan(20)
		expect(all.every((a) => a.variant && a.locales.length > 0)).toBe(true)
	})
})
