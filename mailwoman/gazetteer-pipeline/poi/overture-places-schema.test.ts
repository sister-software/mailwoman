/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for the PURE Overture places-theme column-choice logic `ingestPlaces` uses
 *   (`chooseCategoryColumn` / `hasBrandColumn`) — exercised directly over synthetic `DESCRIBE`
 *   result rows, no DuckDB/network involved. `ingestPlaces` itself (the DuckDB S3 read) isn't
 *   covered here; see the task report for why that side stays untested (no network in CI).
 */

import { describe, expect, it } from "vitest"

import { chooseCategoryColumn, hasBrandColumn, type DescribeColumn } from "./build-poi.ts"

const OLDER_RELEASE_COLUMNS: DescribeColumn[] = [
	{ column_name: "id" },
	{ column_name: "names" },
	{ column_name: "categories" },
	{ column_name: "confidence" },
	{ column_name: "geometry" },
	{ column_name: "country" },
]

const NEWER_RELEASE_COLUMNS: DescribeColumn[] = [
	{ column_name: "id" },
	{ column_name: "names" },
	{ column_name: "categories" },
	{ column_name: "taxonomy" },
	{ column_name: "brand" },
	{ column_name: "confidence" },
	{ column_name: "geometry" },
	{ column_name: "country" },
]

describe("chooseCategoryColumn", () => {
	it("prefers taxonomy.primary when the taxonomy column is present", () => {
		expect(chooseCategoryColumn(NEWER_RELEASE_COLUMNS)).toBe("taxonomy.primary")
	})

	it("falls back to categories.primary when taxonomy is absent", () => {
		expect(chooseCategoryColumn(OLDER_RELEASE_COLUMNS)).toBe("categories.primary")
	})

	it("falls back to categories.primary on an empty column list", () => {
		expect(chooseCategoryColumn([])).toBe("categories.primary")
	})
})

describe("hasBrandColumn", () => {
	it("detects the brand STRUCT column when present", () => {
		expect(hasBrandColumn(NEWER_RELEASE_COLUMNS)).toBe(true)
	})

	it("reports absent when the release predates brand", () => {
		expect(hasBrandColumn(OLDER_RELEASE_COLUMNS)).toBe(false)
	})
})
