// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { readRegionNames } from "#build/region-names"

let scratch: TemporaryDirectory

beforeEach(async () => {
	scratch = await temporaryDirectory("mailwoman-region-names-")
})

afterEach(async () => {
	await scratch[Symbol.asyncDispose]()
})

/**
 * A WOF admin database with the three tables the reader joins, holding `regions`.
 */
function writeDatabase(
	regions: {
		id: number
		name: string
		placetype: string
		country: string
		deprecated?: boolean
		names?: string[]
		abbr?: string
	}[]
) {
	const path = scratch.path("admin.db")
	using db = new DatabaseClient<WOFDatabase>(path)

	db.exec(`
		CREATE TABLE spr (id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT, is_deprecated INTEGER);
		CREATE TABLE names (id INTEGER NOT NULL, language TEXT, name TEXT NOT NULL);
		CREATE TABLE place_abbr (id INTEGER, abbr TEXT);
	`)

	for (const region of regions) {
		db.prepare("INSERT INTO spr VALUES (?, ?, ?, ?, ?)").run(
			region.id,
			region.name,
			region.placetype,
			region.country,
			region.deprecated ? 1 : 0
		)

		for (const name of region.names ?? []) {
			db.prepare("INSERT INTO names VALUES (?, 'abbr', ?)").run(region.id, name)
		}

		if (region.abbr) {
			db.prepare("INSERT INTO place_abbr VALUES (?, ?)").run(region.id, region.abbr)
		}
	}

	return path
}

describe("readRegionNames", () => {
	it("holds a region's name, its names rows and its abbreviation, folded, and nothing else of its country", async () => {
		const regions = await readRegionNames(
			writeDatabase([
				{ id: 1, name: "Texas", placetype: "region", country: "US", names: ["Tex."], abbr: "TX" },
				{ id: 2, name: "Québec", placetype: "region", country: "CA", abbr: "QC" },
				{ id: 3, name: "England", placetype: "macroregion", country: "GB" },
				{ id: 4, name: "Old Province", placetype: "region", country: "US", deprecated: true },
				{ id: 5, name: "Harris County", placetype: "county", country: "US" },
			])
		)

		expect(regions.holds("US", "TX")).toBe(true)
		expect(regions.holds("US", "texas")).toBe(true)
		expect(regions.holds("US", "Tex.")).toBe(true)
		expect(regions.holds("CA", "Quebec")).toBe(true)
		expect(regions.holds("GB", "England")).toBe(true)

		// `1811 Hayes Avenue, Hull, IA IA` read with `IA IA` as the region, a deprecated region and a county.
		expect(regions.holds("US", "IA IA")).toBe(false)
		expect(regions.holds("US", "Old Province")).toBe(false)
		expect(regions.holds("US", "Harris County")).toBe(false)

		// The postal codes libaddressinput keys join WOF's: the military `AE`, which WOF
		// doesn't hold, and Turin's province `TO` in a country with no row in this database.
		expect(regions.holds("US", "AE")).toBe(true)
		expect(regions.holds("IT", "TO")).toBe(true)
		expect(regions.holds("IT", "Torino")).toBe(true)
		expect(regions.holds("IT", "XX")).toBe(false)

		// A country neither source holds a region of isn't judged.
		expect(regions.holds("AQ", "Ross Dependency")).toBeNull()
	})

	it("refuses a database without regions rather than judging no row", async () => {
		await expect(
			readRegionNames(writeDatabase([{ id: 5, name: "Harris County", placetype: "county", country: "US" }]))
		).rejects.toThrow(/holds no region/)
	})
})
