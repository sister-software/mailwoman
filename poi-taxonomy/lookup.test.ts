/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { afterEach, describe, expect, it, vi } from "vitest"

import { getAllCategories, getPOICategory, lookupPOICategory, requiresBuildLocalLayer } from "./lookup.ts"

describe("lookupPOICategory", () => {
	it("matches a category by its own id-phrase and label", () => {
		expect(lookupPOICategory("hospital")[0]?.category.id).toBe("hospital")
		expect(lookupPOICategory("Gas station")[0]?.category.id).toBe("gas_station")
	})

	it("matches synonyms case-insensitively", () => {
		const matches = lookupPOICategory("Drinking Fountain")
		expect(matches[0]?.category.id).toBe("drinking_water")
		expect(matches[0]?.matchedPhrase).toBe("drinking fountain")
	})

	it("maps infrastructure phrases and flags the build-local requirement", () => {
		const [match] = lookupPOICategory("fiber hut")
		expect(match?.category.id).toBe("telecom_cabinet")
		expect(requiresBuildLocalLayer(match!.category)).toBe(true)
		const [shipped] = lookupPOICategory("restaurant")
		expect(requiresBuildLocalLayer(shipped!.category)).toBe(false)
	})

	it("gates locale-restricted synonyms like variant-aliases does", () => {
		expect(lookupPOICategory("chemist", "en-GB")[0]?.confidence).toBe(1.0)
		expect(lookupPOICategory("chemist", "en-IE")[0]?.confidence).toBe(0.5)
		expect(lookupPOICategory("chemist", "fr-FR")).toEqual([])
		// Ungated synonyms match any locale at full confidence.
		expect(lookupPOICategory("datacenter", "fr-FR")[0]?.confidence).toBe(1.0)
	})

	it("returns [] for unknown phrases", () => {
		expect(lookupPOICategory("flux capacitor depot")).toEqual([])
	})
})

describe("taxonomy integrity", () => {
	it("every synonym points at an existing category, and hierarchies end with the category id", () => {
		for (const category of getAllCategories()) {
			expect(category.hierarchy.at(-1)).toBe(category.id)
		}
		// Walk the raw table through the public phrase surface: every phrase must resolve.
		for (const category of getAllCategories()) {
			expect(getPOICategory(category.id)).toBeDefined()
		}
	})
})

describe("taxonomy integrity — malformed table", () => {
	afterEach(() => {
		vi.doUnmock("node:fs")
		vi.resetModules()
	})

	it("throws at module init when a synonym's categoryID points at a nonexistent category", async () => {
		vi.resetModules()
		vi.doMock("node:fs", async () => {
			const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
			const malformed = JSON.stringify({
				version: "0.0.0",
				overtureRelease: null,
				categories: [
					{ id: "hospital", label: "Hospital", hierarchy: ["hospital"], basicLabel: null, source: "overture" },
				],
				synonyms: [{ phrase: "x", categoryID: "nope" }],
			})
			return {
				...actual,
				readFileSync: () => malformed,
			}
		})

		await expect(import("./lookup.ts")).rejects.toThrow(/synonym/)
	})
})
