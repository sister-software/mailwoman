/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for the PURE Overture places-theme column-choice logic `ingestPlaces` uses
 *   (`chooseCategoryColumn` / `hasBrandColumn` / `chooseCountryExpression`) — exercised directly over
 *   synthetic `DESCRIBE` result rows, no DuckDB/network involved. `ingestPlaces` itself (the DuckDB S3
 *   read) isn't covered here; see the task report for why that side stays untested (no network in CI).
 *
 *   `chooseCountryExpression` fixtures cover three release shapes: an (imagined) older release with a
 *   top-level `country` column, the real 2026-05-20.0 places release which has NEITHER a top-level
 *   `country` column NOR a `categories`-only shape but DOES have `addresses`, and a pathological release
 *   with neither `country` nor `addresses` (must throw).
 */

import { describe, expect, it } from "vitest"

import { chooseCategoryColumn, chooseCountryExpression, hasBrandColumn, type DescribeColumn } from "./build-poi.ts"

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

/** The real 2026-05-20.0 places-theme shape: no top-level `country`, but an `addresses` LIST<STRUCT<...>>. */
const PLACES_2026_05_20_COLUMNS: DescribeColumn[] = [
	{ column_name: "id" },
	{ column_name: "names" },
	{ column_name: "categories" },
	{ column_name: "taxonomy" },
	{ column_name: "brand" },
	{ column_name: "addresses" },
	{ column_name: "confidence" },
	{ column_name: "geometry" },
	{ column_name: "sources" },
]

/** Pathological: neither a top-level `country` nor an `addresses` column to derive one from. */
const NO_COUNTRY_SOURCE_COLUMNS: DescribeColumn[] = [
	{ column_name: "id" },
	{ column_name: "names" },
	{ column_name: "categories" },
	{ column_name: "confidence" },
	{ column_name: "geometry" },
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

describe("chooseCountryExpression", () => {
	it("prefers a top-level `country` column when present", () => {
		expect(chooseCountryExpression(OLDER_RELEASE_COLUMNS)).toEqual({
			filterExpr: "country",
			selectExpr: "country",
		})
		expect(chooseCountryExpression(NEWER_RELEASE_COLUMNS)).toEqual({
			filterExpr: "country",
			selectExpr: "country",
		})
	})

	it("falls back to addresses[1].country on the real 2026-05-20.0 places shape (no top-level country)", () => {
		expect(chooseCountryExpression(PLACES_2026_05_20_COLUMNS)).toEqual({
			filterExpr: "addresses[1].country",
			selectExpr: "addresses[1].country AS country",
		})
	})

	it("throws a clear error when neither country nor addresses is present", () => {
		expect(() => chooseCountryExpression(NO_COUNTRY_SOURCE_COLUMNS)).toThrowError(
			/neither a top-level "country" column nor an "addresses" column/
		)
	})

	it("throws on an empty column list", () => {
		expect(() => chooseCountryExpression([])).toThrowError(/neither a top-level "country" column/)
	})
})
