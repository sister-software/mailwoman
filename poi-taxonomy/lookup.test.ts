/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
	getAllCategories,
	getPOICategory,
	lookupPOICategory,
	requiresBuildLocalLayer,
	resolveOvertureCategories,
} from "./lookup.ts"
import { generateTaxonomyTable, serializeTaxonomyTable } from "./scripts/generate-taxonomy.ts"

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

	it("every osmTag present is well-formed, and every mailwoman-infra category carries one", () => {
		for (const category of getAllCategories()) {
			// The full Overture snapshot ships ~2k categories with NO osmTag (the CSV has no OSM mapping); osmTag is a
			// curated field. Assert it's well-formed WHEN present, and required on the infra classes the Overpass
			// emitter must be able to render.
			if (category.osmTag !== undefined) {
				expect(category.osmTag, `malformed osmTag on ${category.id}`).toMatch(/^[a-z_]+=[a-z_]+$/)
			}

			if (category.source === "mailwoman-infra") {
				expect(category.osmTag, `osmTag missing on mailwoman-infra ${category.id}`).toMatch(/^[a-z_]+=[a-z_]+$/)
			}
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

describe("full Overture snapshot + curated overlay", () => {
	it("ships the full snapshot: well over 1900 categories, plus the 6 mailwoman-infra classes", () => {
		const categories = getAllCategories()
		expect(categories.length).toBeGreaterThan(1900)
		expect(categories.filter((c) => c.source === "mailwoman-infra")).toHaveLength(6)
	})

	it("carries brand-new Overture identity categories that the seed taxonomy never had", () => {
		// `acupuncture` is a real Overture leaf with no curated overlay — it must resolve identity-style (#1206 fallback).
		const acupuncture = getPOICategory("acupuncture")
		expect(acupuncture?.source).toBe("overture")
		expect(acupuncture?.hierarchy.at(-1)).toBe("acupuncture")
		expect(resolveOvertureCategories("acupuncture")).toEqual(["acupuncture"])
	})

	it("curated records WIN id collisions and keep owning their synonym phrases (board depends on it)", () => {
		// `supermarket`/`cafe`/`trail`/`bank`/`school` all exist as Overture codes too, but the curated record wins:
		// its curated `overtureCategories` rollup survives, not a bare identity mapping.
		expect(getPOICategory("supermarket")?.overtureCategories).toContain("grocery_store")
		expect(resolveOvertureCategories("cafe")).toEqual(["cafe", "coffee_shop"])

		// The Overture leaves those curated records absorb (`coffee_shop`, `grocery_store`, `hiking_trail`) are NOT
		// emitted as standalone categories — otherwise their id-phrase would shadow the curated synonym in the index.
		expect(getPOICategory("coffee_shop")).toBeUndefined()
		expect(getPOICategory("grocery_store")).toBeUndefined()
		expect(getPOICategory("hiking_trail")).toBeUndefined()

		// The board-canary phrases resolve to the CURATED id, with no absorbed leaf leaking in as a second match.
		expect(lookupPOICategory("coffee shop").map((m) => m.category.id)).toEqual(["cafe"])
		expect(lookupPOICategory("hiking trail").map((m) => m.category.id)).toEqual(["trail"])
		expect(lookupPOICategory("grocery").map((m) => m.category.id)).toEqual(["supermarket"])
		expect(lookupPOICategory("supermarket").map((m) => m.category.id)).toEqual(["supermarket"])
	})

	it("regenerates deterministically and matches the committed table by content", () => {
		// The generator is self-deterministic: two runs produce byte-identical output (no Map/sort nondeterminism).
		const once = serializeTaxonomyTable(generateTaxonomyTable())
		expect(serializeTaxonomyTable(generateTaxonomyTable())).toBe(once)

		// The committed taxonomy.json is the generator's output run through oxfmt (repo law: committed JSON is
		// oxfmt-clean — short arrays inline — which `JSON.stringify` can't reproduce byte-for-byte). So the committed
		// file is compared by PARSED content, not raw bytes: same data, formatting aside.
		const committed = JSON.parse(readFileSync(resolve(import.meta.dirname, "data/taxonomy.json"), "utf8"))
		expect(committed).toEqual(generateTaxonomyTable())
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
