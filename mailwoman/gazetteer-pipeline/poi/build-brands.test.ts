/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for {@linkcode aggregateBrands} (the pure aggregation core) and {@linkcode buildBrandTable} /
 *   {@linkcode serializeBrandTable}, exercised entirely via injected `BrandNameCount` fixtures and an
 *   injected `sourceLayer` — mirrors `build-poi.test.ts`'s injected-`rows` seam, so this suite never
 *   touches `node:sqlite`.
 */

import type { POIBrandTable } from "@mailwoman/poi-taxonomy"
import { describe, expect, it } from "vitest"

import {
	aggregateBrands,
	buildBrandTable,
	type BrandNameCount,
	DEFAULT_MIN_ROWS,
	serializeBrandTable,
} from "./build-brands.ts"

const SOURCE_LAYER = { name: "poi", version: "2026-05-20.0", sourceVintage: "2026-05-20.0" }

describe("aggregateBrands", () => {
	it("sums per-QID rows across name variants and picks the modal name", () => {
		const rows: BrandNameCount[] = [
			{ wikidata: "Q1", name: "Foo's", n: 20 },
			{ wikidata: "Q1", name: "Foos", n: 5 },
		]

		const [brand] = aggregateBrands(rows, 10)
		expect(brand).toMatchObject({ wikidata: "Q1", name: "Foo's", rows: 25 })
	})

	it("drops brands under the minRows floor, keeps ones at or above it", () => {
		const rows: BrandNameCount[] = [
			{ wikidata: "Q1", name: "Big Chain", n: 25 },
			{ wikidata: "Q2", name: "Tiny Shop", n: 24 },
		]

		const brands = aggregateBrands(rows, 25)
		expect(brands.map((b) => b.wikidata)).toEqual(["Q1"])
	})

	it("breaks a modal-name count tie alphabetically", () => {
		const rows: BrandNameCount[] = [
			{ wikidata: "Q1", name: "Zeta Mart", n: 15 },
			{ wikidata: "Q1", name: "Alpha Mart", n: 15 },
		]

		const [brand] = aggregateBrands(rows, 1)
		expect(brand!.name).toBe("Alpha Mart")
		expect(brand!.aliases).toEqual(["Zeta Mart"])
	})

	it("applies the noise floor max(3, 1% of rows) to aliases, dropping sub-floor variants", () => {
		// rows total = 1000 -> floor = max(3, 10) = 10. An 8-row variant is noise; a 10-row variant clears it.
		const rows: BrandNameCount[] = [
			{ wikidata: "Q1", name: "Main Co", n: 982 },
			{ wikidata: "Q1", name: "Main Co Alt Spelling", n: 10 },
			{ wikidata: "Q1", name: "Typo Co", n: 8 },
		]

		const [brand] = aggregateBrands(rows, 1)
		expect(brand!.aliases).toEqual(["Main Co Alt Spelling"])
	})

	it("uses the flat floor of 3 when 1% of rows is smaller", () => {
		// rows total = 30 -> floor = max(3, 0.3) = 3. A 2-row variant is noise; a 3-row variant clears it.
		const rows: BrandNameCount[] = [
			{ wikidata: "Q1", name: "Main Co", n: 25 },
			{ wikidata: "Q1", name: "Clears Floor", n: 3 },
			{ wikidata: "Q1", name: "Below Floor", n: 2 },
		]

		const [brand] = aggregateBrands(rows, 1)
		expect(brand!.aliases).toEqual(["Clears Floor"])
	})

	it("sorts aliases alphabetically, independent of their count order", () => {
		const rows: BrandNameCount[] = [
			{ wikidata: "Q1", name: "Main Co", n: 100 },
			{ wikidata: "Q1", name: "Zeta Alias", n: 20 },
			{ wikidata: "Q1", name: "Alpha Alias", n: 10 },
		]

		const [brand] = aggregateBrands(rows, 1)
		expect(brand!.aliases).toEqual(["Alpha Alias", "Zeta Alias"])
	})

	it("sorts brands by rows descending, ties broken by wikidata ascending", () => {
		const rows: BrandNameCount[] = [
			{ wikidata: "Q2", name: "B Chain", n: 50 },
			{ wikidata: "Q1", name: "A Chain", n: 50 },
			{ wikidata: "Q3", name: "C Chain", n: 100 },
		]

		const brands = aggregateBrands(rows, 1)
		expect(brands.map((b) => b.wikidata)).toEqual(["Q3", "Q1", "Q2"])
	})

	it("is order-independent — shuffled input rows produce the identical sorted output (determinism proof)", () => {
		const rows: BrandNameCount[] = [
			{ wikidata: "Q3", name: "C Chain", n: 100 },
			{ wikidata: "Q1", name: "A Chain", n: 50 },
			{ wikidata: "Q1", name: "A Chain Alt", n: 10 },
			{ wikidata: "Q2", name: "B Chain", n: 50 },
		]
		const shuffled = [rows[3]!, rows[1]!, rows[0]!, rows[2]!]

		expect(aggregateBrands(shuffled, 1)).toEqual(aggregateBrands(rows, 1))
	})

	it("defaults minRows to DEFAULT_MIN_ROWS when omitted", () => {
		const rows: BrandNameCount[] = [{ wikidata: "Q1", name: "Just Under", n: DEFAULT_MIN_ROWS - 1 }]
		expect(aggregateBrands(rows)).toEqual([])

		const atFloor: BrandNameCount[] = [{ wikidata: "Q1", name: "Right At Floor", n: DEFAULT_MIN_ROWS }]
		expect(aggregateBrands(atFloor)).toHaveLength(1)
	})
})

describe("buildBrandTable", () => {
	it("wraps aggregateBrands' output with the injected sourceLayer + version", async () => {
		const rows: BrandNameCount[] = [{ wikidata: "Q1", name: "Chain Co", n: 30 }]

		const table = await buildBrandTable({ rows, sourceLayer: SOURCE_LAYER, minRows: 25, version: "test-1.0.0" })

		expect(table).toEqual({
			version: "test-1.0.0",
			sourceLayer: SOURCE_LAYER,
			brands: [{ wikidata: "Q1", name: "Chain Co", aliases: [], rows: 30 }],
		})
	})

	it("throws when given neither rows nor dbPath", async () => {
		await expect(buildBrandTable({ sourceLayer: SOURCE_LAYER })).rejects.toThrow(/rows.*dbPath/)
	})

	it("throws when given rows but no sourceLayer/dbPath", async () => {
		await expect(buildBrandTable({ rows: [] })).rejects.toThrow(/sourceLayer.*dbPath/)
	})
})

describe("serializeBrandTable", () => {
	it("is byte-identical across repeated calls on an equivalent table (determinism proof)", () => {
		const table = {
			version: "0.1.0",
			sourceLayer: SOURCE_LAYER,
			brands: [{ wikidata: "Q1", name: "Chain Co", aliases: ["Alt Co"], rows: 30 }],
		} as unknown as POIBrandTable

		expect(serializeBrandTable(table)).toBe(serializeBrandTable(structuredClone(table)))
		expect(serializeBrandTable(table).endsWith("\n")).toBe(true)
	})
})
