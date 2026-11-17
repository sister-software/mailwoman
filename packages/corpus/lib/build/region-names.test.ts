// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { readRegionNames, readSecondLevelNames } from "#build/region-names"

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
		hasc?: string
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

		if (region.hasc) {
			db.prepare("INSERT INTO concordances VALUES (?, ?, 'hasc:id')").run(region.id, region.hasc)
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

	it("holds an Arabic region written with ه for ة, ى for ي or a bare alef for a hamza-carrying one", async () => {
		const regions = await readRegionNames(
			writeDatabase([
				{ id: 1, name: "Al Isma`iliyah", placetype: "region", country: "EG", names: ["الإسماعيلية"] },
				{ id: 2, name: "Al Wadi at Jadid", placetype: "region", country: "EG", names: ["الوادي الجديد"] },
			])
		)

		// `81 حارة عبد الرحمن, مكه, الاسماعيليه, 41511` and `8 شارع 4, مدينه الخارجه, الوادى الجديد, 72511`.
		expect(regions.holds("EG", "الاسماعيليه")).toBe(true)
		expect(regions.holds("EG", "الوادى الجديد")).toBe(true)
		expect(regions.holds("EG", "الجديد")).toBe(false)
	})

	it("holds a dependency's region under the dependency when the region's ISO or HASC code is the dependency's", async () => {
		const regions = await readRegionNames(
			writeDatabase([
				{ id: 1, name: "French Guiana", placetype: "region", country: "FR", names: ["Guyane Francaise"], iso: "GF" },
				{ id: 2, name: "Bonaire", placetype: "region", country: "NL", iso: "BQ-BO", hasc: "BQ.BO" },
				{ id: 3, name: "Île-de-France", placetype: "region", country: "FR", hasc: "FR.IF" },
				{ id: 4, name: "Mayotte", placetype: "country", country: "YT" },
				{ id: 5, name: "Mamoudzou", placetype: "region", country: "YT" },
				{ id: 6, name: "Guyane", placetype: "region", country: "GF" },
				{ id: 7, name: "Saba", placetype: "region", country: "BQ" },
				{ id: 8, name: "Saint-Martin", placetype: "country", country: "MF" },
			])
		)

		// `Gvatemän, French Guiana, France` and `Lagun, Bonaire`.
		expect(regions.holds("GF", "French Guiana")).toBe(true)
		expect(regions.holds("GF", "Guyane Francaise")).toBe(true)
		expect(regions.holds("FR", "French Guiana")).toBe(true)
		expect(regions.holds("BQ", "Bonaire")).toBe(true)
		expect(regions.holds("BQ", "BO")).toBe(true)
		// `Dzoumonye, Mayotte, France`: the dependency's own record.
		expect(regions.holds("YT", "Mayotte")).toBe(true)
		// A sovereign state's region whose code is its own country's lends no name elsewhere.
		expect(regions.holds("GF", "Île-de-France")).toBe(false)
		// A dependency with no region of its own stays unjudged rather than judged on one name.
		expect(regions.holds("MF", "Île de Saint-Martin")).toBeNull()
	})

	it("strips the resolver's county and province qualifiers and reads a slash-joined pair of names", async () => {
		const regions = await readRegionNames(
			writeDatabase([
				{ id: 1, name: "Panamá Oeste", placetype: "region", country: "PA" },
				{ id: 2, name: "Kerry", placetype: "region", country: "IE" },
				{ id: 3, name: "Cataluña", placetype: "region", country: "ES", names: ["Catalunya"] },
				{ id: 4, name: "Constanța", placetype: "region", country: "RO" },
			])
		)

		expect(regions.holds("PA", "Panamá Oeste Province")).toBe(true)
		expect(regions.holds("IE", "Co. Kerry")).toBe(true)
		expect(regions.holds("ES", "Cataluña/Catalunya")).toBe(true)
		expect(regions.holds("ES", "Cataluña/Andalucía")).toBe(false)
		// The resolver's qualifier list holds no `County` suffix.
		expect(regions.holds("RO", "Constanța County")).toBe(false)
	})

	it("holds a second-level name only for a country the census admitted", async () => {
		const database = writeDatabase([
			{ id: 1, name: "Ayacucho", placetype: "region", country: "PE" },
			{ id: 2, name: "Huamanga", placetype: "county", country: "PE" },
			{ id: 3, name: "Texas", placetype: "region", country: "US" },
			{ id: 4, name: "Harris County", placetype: "county", country: "US" },
		])

		const admitted = await readRegionNames(database, { secondLevelCountries: ["PE"] })
		const secondLevel = await readSecondLevelNames(database)

		// `Jr. S. Rosa de Lima 10, Jesús Nazareno, 05011, Huamanga`.
		expect(admitted.holds("PE", "Huamanga")).toBe(true)
		expect(admitted.holds("US", "Harris County")).toBe(false)
		expect((await readRegionNames(database)).holds("PE", "Huamanga")).toBe(false)
		expect(secondLevel.holds("US", "Harris County")).toBe(true)
		expect(secondLevel.holds("PE", "Ayacucho")).toBe(false)
	})

	it("holds a region written without its spaces or with a run of its words as initials", async () => {
		const regions = await readRegionNames(
			writeDatabase([
				{ id: 1, name: "Nakhon Phanom", placetype: "region", country: "TH", names: ["จังหวัดชลบุรี"] },
				{ id: 2, name: "Yogyakarta", placetype: "region", country: "ID", names: ["Daerah Istimewa Yogyakarta"] },
				{ id: 3, name: "Nusa Tenggara Barat", placetype: "region", country: "ID" },
				{ id: 4, name: "Jawa Barat", placetype: "region", country: "ID" },
			])
		)

		// `35/5 NakhonPhanom-TardPhanom Road, …, NakhonPhanom 48000` and `…, จังหวัด ชลบุรี 20230`.
		expect(regions.holds("TH", "NakhonPhanom")).toBe(true)
		expect(regions.holds("TH", "จังหวัด ชลบุรี")).toBe(true)
		// `102/8 ซอยแกรก 4, Nong Pla Eel, ชลบุรี 20150`, whose region ends in a zero-width space.
		expect(regions.holds("TH", "จังหวัดชลบุรี​")).toBe(true)
		// `Jalan Janti 379, Banguntapan, Bantul, DIY 55198` and `…, Kota Bima, NTB 84113`.
		expect(regions.holds("ID", "DIY")).toBe(true)
		expect(regions.holds("ID", "DI Yogyakarta")).toBe(true)
		expect(regions.holds("ID", "D.I. Yogyakarta")).toBe(true)
		expect(regions.holds("ID", "NTB")).toBe(true)
		// A two-word name never collapses to two letters.
		expect(regions.holds("ID", "JB")).toBe(false)
		expect(regions.holds("ID", "Yogya")).toBe(false)
	})

	it("widens a judged country with GeoNames first-level names and refuses a missing GeoNames file", async () => {
		const database = writeDatabase([
			{ id: 1, name: "County Cork", placetype: "region", country: "IE" },
			{ id: 2, name: "Texas", placetype: "region", country: "US" },
		])

		await writeLocalTextFile(
			["IE.M\tMunster\tMunster\t7521315", "FO.ST\tStreymoy\tStreymoy\t2612225"],
			scratch.path("geonames", "admin1CodesASCII.txt")
		)

		const regions = await readRegionNames(database, { geonamesDirectory: scratch.path("geonames") })

		// `Foynes, Munster`, a GeoNames feature whose region is its admin1 name.
		expect(regions.holds("IE", "Munster")).toBe(true)
		expect(regions.holds("US", "Munster")).toBe(false)
		// GeoNames names widen a country WOF holds a region of and judge no other.
		expect(regions.holds("FO", "Streymoy")).toBeNull()

		await expect(readRegionNames(database, { geonamesDirectory: scratch.path("absent") })).rejects.toThrow(
			/admin1CodesASCII\.txt is missing/
		)
	})

	it("refuses a database without regions rather than judging no row", async () => {
		await expect(
			readRegionNames(writeDatabase([{ id: 5, name: "Harris County", placetype: "county", country: "US" }]))
		).rejects.toThrow(/holds no region/)
	})
})
