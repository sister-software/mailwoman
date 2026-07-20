/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { afterEach, describe, expect, it, vi } from "vitest"

import {
	getAllCategories,
	getPOICategory,
	lookupPOICategory,
	requiresBuildLocalLayer,
	resolveOvertureCategories,
} from "./lookup.ts"

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

	it("every category carries a well-formed osmTag", () => {
		for (const category of getAllCategories()) {
			expect(category.osmTag, `osmTag missing on ${category.id}`).toMatch(/^[a-z_]+=[a-z_]+$/)
		}
	})
})

describe("resolveOvertureCategories", () => {
	it("fans a mismatched seed id out over its Overture leaves", () => {
		const supermarket = resolveOvertureCategories("supermarket")
		expect(supermarket).toContain("grocery_store")
		// The curated seed id itself is NOT a stored Overture leaf — it must not leak into the probe list.
		expect(supermarket).not.toContain("supermarket")

		const trail = resolveOvertureCategories("trail")
		expect(trail).toEqual(["hiking_trail", "mountain_bike_trail", "recreational_trail_or_path"])
	})

	it("keeps the canonical id when a category adds sibling leaves (cafe → cafe + coffee_shop)", () => {
		expect(resolveOvertureCategories("cafe")).toEqual(["cafe", "coffee_shop"])
	})

	it("defaults to identity for a seed id that already equals its Overture leaf", () => {
		expect(resolveOvertureCategories("hotel")).toEqual(["hotel"])
		expect(resolveOvertureCategories("restaurant")).toEqual(["restaurant"])
	})

	it("returns [] for an unknown seed id (clean miss, mirrors getPOICategory)", () => {
		expect(resolveOvertureCategories("flux_capacitor_depot")).toEqual([])
	})

	it("every declared Overture leaf is a distinct string, and identity holds for the undeclared rest", () => {
		for (const category of getAllCategories()) {
			const leaves = resolveOvertureCategories(category.id)

			if (category.overtureCategories && category.overtureCategories.length > 0) {
				expect(leaves).toEqual([...category.overtureCategories])
			} else {
				expect(leaves).toEqual([category.id])
			}
		}
	})
})

describe("lookup without a locale", () => {
	it("hides locale-gated synonyms and keeps ungated ones", () => {
		expect(lookupPOICategory("chemist")).toEqual([])
		expect(lookupPOICategory("drinking fountain")[0]?.confidence).toBe(1.0)
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
