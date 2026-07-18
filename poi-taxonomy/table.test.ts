/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { lookupPOICategory as nodeLookupPOICategory } from "./lookup.ts"
import { createPOITaxonomyLookup } from "./table.ts"
import type { CategoryRecord, POITaxonomyTable } from "./types.ts"

const hospital: CategoryRecord = {
	id: "hospital" as CategoryRecord["id"],
	label: "Hospital",
	hierarchy: ["health_and_medical", "hospital"] as CategoryRecord["hierarchy"],
	basicLabel: "Hospital",
	osmTag: "amenity=hospital",
	source: "overture",
}

const telecomCabinet: CategoryRecord = {
	id: "telecom_cabinet" as CategoryRecord["id"],
	label: "Telecom cabinet",
	hierarchy: ["telecom_cabinet"] as CategoryRecord["hierarchy"],
	basicLabel: null,
	osmTag: "man_made=street_cabinet",
	source: "mailwoman-infra",
}

const TWO_CATEGORY_TABLE: POITaxonomyTable = {
	version: "test-0.0.1",
	overtureRelease: null,
	categories: [hospital, telecomCabinet],
	synonyms: [
		// Locale-gated synonym case, same semantics as the node entry's `chemist` fixture.
		{ phrase: "hospice", categoryID: hospital.id, locales: ["en-GB"] },
		// Infra-flag case: an ungated synonym pointing at the mailwoman-infra category.
		{ phrase: "fiber hut", categoryID: telecomCabinet.id },
	],
}

describe("createPOITaxonomyLookup", () => {
	it("matches categories by id-phrase and label from the injected table", () => {
		const lookup = createPOITaxonomyLookup(TWO_CATEGORY_TABLE)

		expect(lookup.lookupPOICategory("hospital")[0]?.category.id).toBe("hospital")
		expect(lookup.lookupPOICategory("Telecom cabinet")[0]?.category.id).toBe("telecom_cabinet")
	})

	it("gates locale-restricted synonyms like the node entry does", () => {
		const lookup = createPOITaxonomyLookup(TWO_CATEGORY_TABLE)

		expect(lookup.lookupPOICategory("hospice", "en-GB")[0]?.confidence).toBe(1.0)
		expect(lookup.lookupPOICategory("hospice", "en-IE")[0]?.confidence).toBe(0.5)
		expect(lookup.lookupPOICategory("hospice", "fr-FR")).toEqual([])
		expect(lookup.lookupPOICategory("hospice")).toEqual([])
	})

	it("maps infrastructure phrases and flags the build-local requirement", () => {
		const lookup = createPOITaxonomyLookup(TWO_CATEGORY_TABLE)

		const [match] = lookup.lookupPOICategory("fiber hut")
		expect(match?.category.id).toBe("telecom_cabinet")
		expect(lookup.requiresBuildLocalLayer(match!.category)).toBe(true)

		const [shipped] = lookup.lookupPOICategory("hospital")
		expect(lookup.requiresBuildLocalLayer(shipped!.category)).toBe(false)
	})

	it("exposes getPOICategory / getAllCategories over the injected table", () => {
		const lookup = createPOITaxonomyLookup(TWO_CATEGORY_TABLE)

		expect(lookup.getPOICategory("hospital")).toBe(hospital)
		expect(lookup.getPOICategory("nonexistent")).toBeUndefined()
		expect(lookup.getAllCategories()).toEqual([hospital, telecomCabinet])
	})

	it("throws at construction when a synonym's categoryID points at a nonexistent category", () => {
		const malformed: POITaxonomyTable = {
			version: "test-0.0.1",
			overtureRelease: null,
			categories: [hospital],
			synonyms: [{ phrase: "x", categoryID: "nope" as CategoryRecord["id"] }],
		}

		expect(() => createPOITaxonomyLookup(malformed)).toThrow(/synonym/)
	})

	it("agrees with the node entry on a shared phrase from the real taxonomy table", async () => {
		// Load the same JSON the node entry loads, via node:fs directly (this test file itself runs under node, so
		// this doesn't exercise bundler-safety — it just proves the two entries agree over the real table).
		const { readFileSync } = await import("node:fs")
		const { resolve } = await import("node:path")
		const table = JSON.parse(
			readFileSync(resolve(import.meta.dirname, "data/taxonomy.json"), "utf8")
		) as POITaxonomyTable

		const injectedLookup = createPOITaxonomyLookup(table)

		const injected = injectedLookup.lookupPOICategory("hospital")
		const node = nodeLookupPOICategory("hospital")

		expect(injected).toEqual(node)
	})
})
