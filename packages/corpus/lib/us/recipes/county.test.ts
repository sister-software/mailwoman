// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file `us-county`: the county's designator sits inside its `subregion` span, the designator comes
 *   from the WOF record rather than a guess, and the locality rows reach every county and state.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { mulberry32 } from "@mailwoman/core/math/random"
import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/values/json"
import { createWOFRecordStoreTables, type WOFRecordStoreDatabase } from "@mailwoman/gazetteer/whosonfirst/record-store"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { createUnifiedSchema } from "@mailwoman/resolver-wof-sqlite/schema/unified"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterAll, describe, expect, it } from "vitest"

import { alignAndWrite } from "#recipes/scaffold"
import { recipeSource } from "#recipes/sources"
import type { LabeledRow } from "#types"
import {
	cityCountyRows,
	cityStateRows,
	countyRows,
	countySurface,
	readUSCountyPool,
	US_COUNTY_SOURCES,
	type USCountyPool,
	type USCountyRow,
} from "#us/recipes/county"

const root = await temporaryDirectory("mw-us-county-")

afterAll(() => root[Symbol.asyncDispose]())

/**
 * Admin, postcode and record-store databases holding four counties.
 *
 * - Oregon's Polk County, WOF 102081751: its label writes the designator.
 * - Louisiana's St. Charles Parish, 102081025: it has no label, and an English
 *   variant writes the designator.
 * - Alaska's Chugach Census Area, 1930466631: its records write no designator.
 * - Virginia's independent city of Richmond, 102086813: its label is `City of Richmond`.
 */
async function writeFixture() {
	const adminDB = root.path("admin.db")
	const postcodeDB = root.path("postalcode-us.db")
	const recordStore = root.path("store.db")

	{
		using admin = new DatabaseClient<WOFDatabase>(adminDB)
		await createUnifiedSchema(admin)

		const spr = admin.prepare(
			"INSERT INTO spr (id, parent_id, name, placetype, country, is_current, is_deprecated) VALUES (?, ?, ?, ?, ?, 1, 0)"
		)

		const ancestors = admin.prepare("INSERT INTO ancestors (id, ancestor_id, ancestor_placetype) VALUES (?, ?, ?)")

		for (const [id, name] of [
			[85_688_723, "Oregon"],
			[85_688_735, "Louisiana"],
			[85_688_739, "Alaska"],
			[85_688_747, "Virginia"],
		] as const) {
			spr.run(id, -1, name, "region", "US")
		}

		for (const [id, name, region] of [
			[102_081_751, "Polk", 85_688_723],
			[102_081_025, "St. Charles", 85_688_735],
			[1_930_466_631, "Chugach", 85_688_739],
			[102_086_813, "Richmond", 85_688_747],
		] as const) {
			spr.run(id, region, name, "county", "US")
			ancestors.run(id, region, "region")
		}

		for (const [id, name, county] of [
			[101_730_401, "Dallas", 102_081_751],
			[101_730_403, "Independence", 102_081_751],
			[101_730_405, "Monmouth", 102_081_751],
			[101_729_897, "Luling", 102_081_025],
		] as const) {
			spr.run(id, county, name, "locality", "US")
			ancestors.run(id, county, "county")
		}

		// A locality WOF places in two counties names neither as its own.
		spr.run(101_730_407, 102_081_751, "Salem", "locality", "US")
		ancestors.run(101_730_407, 102_081_751, "county")
		ancestors.run(101_730_407, 102_081_025, "county")

		admin
			.prepare("INSERT INTO names (id, name, language, privateuse, official) VALUES (?, ?, 'eng', ?, 0)")
			.run(102_081_025, "St. Charles Parish", "variant")
	}

	{
		using pc = new DatabaseClient<WOFDatabase>(postcodeDB)
		await createUnifiedSchema(pc)

		const spr = pc.prepare(
			"INSERT INTO spr (id, parent_id, name, placetype, country, is_current) VALUES (?, ?, ?, 'postalcode', 'US', 1)"
		)

		spr.run(1, 101_730_401, "97338")
		spr.run(2, 101_729_897, "70070")
	}

	{
		using store = new DatabaseClient<WOFRecordStoreDatabase>(recordStore)
		await createWOFRecordStoreTables(store)

		const insert = store.prepare(
			"INSERT INTO wof_record (id, repo, path, country, placetype, feature) VALUES (?, 'whosonfirst-data-admin-us', ?, 'US', 'county', ?)"
		)

		for (const [id, properties] of [
			[102_081_751, { "wof:label": "Polk County", "name:eng_x_variant": ["Polk County"] }],
			[102_081_025, {}],
			[1_930_466_631, {}],
			[102_086_813, { "wof:label": "City of Richmond" }],
		] as const) {
			insert.run(id, `${id}.geojson`, stringifyJSON({ type: "Feature", id, properties }))
		}
	}

	return { adminDB, postcodeDB, recordStore }
}

const pool: USCountyPool = await readUSCountyPool(await writeFixture())

/**
 * Each row aligned and written, then read back as the corpus stores it.
 */
function aligned(rows: readonly USCountyRow[]): LabeledRow[] {
	const lines: string[] = []

	for (const { canonical, template } of rows) {
		alignAndWrite((line) => lines.push(line), canonical, template, {
			register: "whos-on-first",
			surface: "composed",
			baseSourceID: null,
		})
	}

	return lines.map((line) => parseJSONStrict<LabeledRow>(line))
}

/**
 * A row's spans as `tag: text` pairs, in order.
 */
function spans(row: LabeledRow): string[] {
	return (row.span_tags ?? []).map((tag, i) => `${tag}: ${row.raw.slice(row.span_starts![i], row.span_ends![i])}`)
}

describe("readUSCountyPool", () => {
	it("takes the designator from the WOF label or an English variant, and sets aside a county whose records write none", () => {
		expect(pool.counties.map((county) => `${county.surface}, ${county.state}`)).toEqual([
			"St. Charles Parish, LA",
			"Polk County, OR",
		])

		expect(pool.setAside.noDesignator).toEqual(["102086813 Richmond, VA", "1930466631 Chugach, AK"])
	})

	it("keeps a locality only when WOF places it in one county, with its own ZIP Codes", () => {
		expect(pool.localities.map((l) => `${l.name} ${l.postcodes.join(" ")}`.trim())).toEqual([
			"Luling 70070",
			"Dallas 97338",
			"Independence",
			"Monmouth",
		])
	})
})

describe("countySurface", () => {
	it("refuses a designator written on another name", () => {
		expect(countySurface("Polk", ["Marion County"])).toBeNull()
		expect(countySurface("Polk", [undefined, "POLK COUNTY"])).toEqual({ surface: "POLK County", designator: "County" })
	})
})

describe("us-county rows", () => {
	it("puts the designator inside the subregion span in both bare forms", () => {
		expect(aligned(countyRows(pool.counties)).map((row) => [row.raw, ...spans(row)])).toEqual([
			["St. Charles Parish, LA", "subregion: St. Charles Parish", "region: LA"],
			["St. Charles Parish, Louisiana", "subregion: St. Charles Parish", "region: Louisiana"],
			["Polk County, OR", "subregion: Polk County", "region: OR"],
			["Polk County, Oregon", "subregion: Polk County", "region: Oregon"],
		])
	})

	it("reaches every county before any county's second locality, and labels the city, county, state and ZIP", () => {
		const rows = aligned(cityCountyRows(pool, 2, mulberry32(7)))

		expect(new Set(rows.map((row) => row.components["subregion"]))).toEqual(
			new Set(["Polk County", "St. Charles Parish"])
		)

		const all = aligned(cityCountyRows(pool, 100, mulberry32(7)))

		expect(all).toHaveLength(pool.localities.length)

		for (const row of all) {
			expect(spans(row).slice(0, 3)).toEqual([
				`locality: ${row.components["locality"]}`,
				`subregion: ${row.components["subregion"]}`,
				`region: ${row.components["region"]}`,
			])
		}

		const withZip = all.find((row) => row.components["postcode"])

		expect(withZip && spans(withZip).at(-1)).toBe(`postcode: ${withZip?.components["postcode"]}`)
	})

	it("writes City, ST rows with no county, some with a ZIP Code and some without", () => {
		const rows = aligned(cityStateRows(pool, 100, mulberry32(7)))

		expect(rows.every((row) => !row.components["subregion"] && row.source === US_COUNTY_SOURCES.cityState)).toBe(true)
		expect(rows.some((row) => /^[^,]+, (OR|LA)$/u.test(row.raw))).toBe(true)
		expect(rows.some((row) => /^[^,]+, (OR|LA) \d{5}$/u.test(row.raw))).toBe(true)
	})

	it("writes three sources the source table records, each naming this recipe", () => {
		for (const source of Object.values(US_COUNTY_SOURCES)) {
			expect(recipeSource(source)?.producer).toBe("us/recipes/county.ts")
		}
	})
})
