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
		iso?: string
	}[]
) {
	const path = scratch.path("admin.db")
	using db = new DatabaseClient<WOFDatabase>(path)

	db.exec(`
		CREATE TABLE spr (id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT, is_deprecated INTEGER);
		CREATE TABLE names (id INTEGER NOT NULL, language TEXT, name TEXT NOT NULL);
		CREATE TABLE place_abbr (id INTEGER, abbr TEXT);
		CREATE TABLE concordances (id INTEGER NOT NULL, other_id TEXT NOT NULL, other_source TEXT NOT NULL);
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

		if (region.iso) {
			db.prepare("INSERT INTO concordances VALUES (?, ?, 'iso:id')").run(region.id, region.iso)
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

	it("holds the lettered part of a region's ISO 3166-2 code, and no numeric part or other country's code", async () => {
		const regions = await readRegionNames(
			writeDatabase([
				{ id: 1, name: "Thurgau", placetype: "region", country: "CH", iso: "CH-TG" },
				{ id: 2, name: "Bangkok", placetype: "region", country: "TH", iso: "TH-10" },
				{ id: 3, name: "Kosovo region", placetype: "region", country: "XK", iso: "RS-KM" },
			])
		)

		// `15 Im Hof, Aadorf, TG 8355`.
		expect(regions.holds("CH", "TG")).toBe(true)
		expect(regions.holds("CH", "tg")).toBe(true)
		expect(regions.holds("TH", "10")).toBe(false)
		expect(regions.holds("XK", "KM")).toBe(false)
	})

	it("holds a region written with one word truncated to a full stop when its other words match a name", async () => {
		const regions = await readRegionNames(
			writeDatabase([
				{ id: 1, name: "Rezeknes", placetype: "region", country: "LV", names: ["Rēzeknes novads"] },
				{ id: 2, name: "Riga", placetype: "region", country: "LV" },
			])
		)

		// `"Bērzu Sala", Rikopole, Stoļerovas pag., Rēzeknes nov., LV-4642`.
		expect(regions.holds("LV", "Rēzeknes nov.")).toBe(true)
		expect(regions.holds("LV", "Rēzeknes nov")).toBe(false)
		expect(regions.holds("LV", "Rēzeknes pag.")).toBe(false)
		expect(regions.holds("LV", "Saldus nov.")).toBe(false)
		// A lone truncated word matches no region.
		expect(regions.holds("LV", "Rēz.")).toBe(false)
	})

	it("refuses a database without regions rather than judging no row", async () => {
		await expect(
			readRegionNames(writeDatabase([{ id: 5, name: "Harris County", placetype: "county", country: "US" }]))
		).rejects.toThrow(/holds no region/)
	})
})
