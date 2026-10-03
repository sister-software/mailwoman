/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { resourceForFile } from "#lv/tools/fetch/varis"

const BASE = "https://data.gov.lv/dati/dataset/6b06a7e8-dedf-4705-a47b-2a7c51177473/resource"

describe("resourceForFile", () => {
	// The dataset lists each table beside its history file and its column metadata.
	const resources = [
		{ url: `${BASE}/d07443d7-15a8-4db6-9e53-7a68eec3c0dd/download/aw_eka_his.csv`, format: "CSV" },
		{ url: `${BASE}/27ab50ae-95ae-46be-88c8-d54d4b4c70b5/download/aw_eka_metadata.json`, format: "JSON" },
		{ url: `${BASE}/a510737a-18ce-400f-ad4b-04fce5228272/download/aw_eka.csv`, format: "CSV" },
	]

	it("matches the whole file name rather than its prefix", () => {
		expect(resourceForFile(resources, "aw_eka.csv").url).toContain("a510737a")
	})

	it("refuses a table the dataset no longer lists", () => {
		expect(() => resourceForFile(resources, "aw_iela.csv")).toThrow(/aw_iela\.csv/u)
	})
})
