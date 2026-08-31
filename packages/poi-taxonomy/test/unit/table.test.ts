/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { lookupPOIBrand as nodeLookupPOIBrand } from "@mailwoman/poi-taxonomy/brands"
import { lookupPOICategory as nodeLookupPOICategory } from "@mailwoman/poi-taxonomy/lookup"
import { createPOIBrandLookup, createPOITaxonomyLookup } from "@mailwoman/poi-taxonomy/table"
import type { BrandRecord, CategoryRecord, POIBrandTable, POITaxonomyTable } from "@mailwoman/poi-taxonomy/types"
import { describe, expect, it } from "vitest"

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
		{ phrase: "hôpital", categoryID: hospital.id, locales: ["fr"] },
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

		expect(lookup.lookupPOICategory("hospice", "en-GB")[0]?.confidence).toBe(1)
		expect(lookup.lookupPOICategory("hospice", "en-IE")[0]?.confidence).toBe(0.5)
		expect(lookup.lookupPOICategory("hospice", "fr-FR")).toEqual([])
		expect(lookup.lookupPOICategory("hospice")).toEqual([])
	})

	it("normalizes diacritics and typos only within the presumed language", () => {
		const lookup = createPOITaxonomyLookup(TWO_CATEGORY_TABLE)

		expect(lookup.lookupPOICategoryLocaleNormalized("hopital", "fr-FR")[0]?.category.id).toBe("hospital")
		expect(lookup.lookupPOICategoryLocaleNormalized("hopital", "en-US")).toEqual([])
		expect(lookup.lookupPOICategoryTypo("hospitl", "en-US")[0]?.category.id).toBe("hospital")
		expect(lookup.lookupPOICategoryTypo("hospitl", "fr-FR")).toEqual([])
		expect(lookup.lookupPOICategoryTypo("hospitl")).toEqual([])
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
		// Load the same JSON the node entry loads, via the core reader (this test file itself runs under node, so
		// this doesn't exercise bundler-safety — it just proves the two entries agree over the real table).

		// oxlint-disable-next-line no-restricted-properties -- `@mailwoman/poi-taxonomy` declares no dependencies.
		const table = (await readLocalJSONFile(
			resolvePackagePath("@mailwoman/poi-taxonomy", "data", "taxonomy.json")
		)) as POITaxonomyTable

		const injectedLookup = createPOITaxonomyLookup(table)

		const injected = injectedLookup.lookupPOICategory("hospital")
		const node = nodeLookupPOICategory("hospital")

		expect(injected).toEqual(node)
	})
})

const chevron: BrandRecord = {
	wikidata: "Q1" as BrandRecord["wikidata"],
	name: "Chevron",
	aliases: ["Chevron Gas"],
	rows: 100,
}

const acme: BrandRecord = {
	wikidata: "Q2" as BrandRecord["wikidata"],
	name: "Acme",
	aliases: [],
	rows: 50,
}

const TWO_BRAND_TABLE: POIBrandTable = {
	version: "test-0.0.1",
	sourceLayer: { name: "poi", version: "test", sourceVintage: "test" },
	brands: [chevron, acme],
}

describe("createPOIBrandLookup", () => {
	it("matches brands by exact name from the injected table", () => {
		const lookup = createPOIBrandLookup(TWO_BRAND_TABLE)

		expect(lookup.lookupPOIBrand("Chevron")[0]?.brand.wikidata).toBe("Q1")
		expect(lookup.lookupPOIBrand("chevron")[0]?.confidence).toBe(1)
	})

	it("matches an alias variant", () => {
		const lookup = createPOIBrandLookup(TWO_BRAND_TABLE)

		const [match] = lookup.lookupPOIBrand("Chevron Gas")
		expect(match?.brand.wikidata).toBe("Q1")
		expect(match?.matchedPhrase).toBe("Chevron Gas")
	})

	it("breaks ties by rows descending when two brands share a phrase", () => {
		const collision: POIBrandTable = {
			version: "test-0.0.1",
			sourceLayer: { name: "poi", version: "test", sourceVintage: "test" },
			brands: [
				{ wikidata: "Q10" as BrandRecord["wikidata"], name: "Shared Name", aliases: [], rows: 10 },
				{ wikidata: "Q20" as BrandRecord["wikidata"], name: "Shared Name", aliases: [], rows: 90 },
			],
		}

		const lookup = createPOIBrandLookup(collision)

		const matches = lookup.lookupPOIBrand("Shared Name")
		expect(matches.map((m) => m.brand.wikidata)).toEqual(["Q20", "Q10"])
	})

	it("returns [] for an unknown phrase", () => {
		const lookup = createPOIBrandLookup(TWO_BRAND_TABLE)
		expect(lookup.lookupPOIBrand("nonexistent brand")).toEqual([])
	})

	it("resolveBrandName wraps lookupPOIBrand's best match", () => {
		const lookup = createPOIBrandLookup(TWO_BRAND_TABLE)

		expect(lookup.resolveBrandName("Acme")).toBe(acme)
		expect(lookup.resolveBrandName("nonexistent brand")).toBeUndefined()
	})

	it("exposes getBrand / getAllBrands over the injected table", () => {
		const lookup = createPOIBrandLookup(TWO_BRAND_TABLE)

		expect(lookup.getBrand("Q1")).toBe(chevron)
		expect(lookup.getBrand("nonexistent")).toBeUndefined()
		expect(lookup.getAllBrands()).toEqual([chevron, acme])
	})

	it("agrees with the node entry on a shared phrase from the real committed brand table", async () => {
		// oxlint-disable-next-line no-restricted-properties -- `@mailwoman/poi-taxonomy` declares no dependencies.
		const table = (await readLocalJSONFile(
			resolvePackagePath("@mailwoman/poi-taxonomy", "data", "brands.json")
		)) as POIBrandTable

		const injectedLookup = createPOIBrandLookup(table)
		const [firstBrand] = table.brands
		expect(firstBrand, "expected the committed brand table to be non-empty").toBeDefined()

		const injected = injectedLookup.lookupPOIBrand(firstBrand!.name)
		const node = nodeLookupPOIBrand(firstBrand!.name)

		expect(injected).toEqual(node)
	})
})
