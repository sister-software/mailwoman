/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #267 — `ingestGeonamesAliases({ includeAdmin: true })` folds the GeoNames A-class admin (PCLI country
 *   + ADM1 regions) alongside the P-class localities and links the locality→region→country ancestry, so
 *   `parentID` scoping and adminCoherence reach the gap countries ("Tbilisi, GE" can resolve).
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile, writeLocalFile } from "@mailwoman/core/fs/writers"
import { ingestGeonamesAliases } from "@mailwoman/resolver-wof-sqlite/geonames"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { join } from "path-ts"
import { afterAll, beforeAll, expect, test } from "vitest"

/**
 * A loose SQLite row shape for the test's column probes (avoids `any` — oxlint no-explicit-any).
 */
type Row = Record<string, string | number | null>

let dir: TemporaryDirectory
let db: DatabaseClient<WOFDatabase>

// One GeoNames row: 19 tab-separated columns (id, name, ascii, alt, lat, lon, fclass, fcode, country, cc2,
// admin1, admin2, admin3, admin4, pop, elev, dem, tz, mod).
function row(over: Record<number, string>): string {
	const f = new Array(19).fill("")

	for (const [i, v] of Object.entries(over)) {
		f[Number(i)] = v
	}

	return f.join("\t")
}

beforeAll(async () => {
	dir = await temporaryDirectory("geonames-admin-")

	const lines = [
		// PCLI country: Georgia
		row({ 0: "614540", 1: "Georgia", 2: "Georgia", 4: "42.0", 5: "43.5", 6: "A", 7: "PCLI", 8: "GE" }),
		// ADM1 region: T'bilisi (admin1 code 51)
		row({ 0: "611716", 1: "Tbilisi", 2: "Tbilisi", 4: "41.7", 5: "44.8", 6: "A", 7: "ADM1", 8: "GE", 10: "51" }),
		// PPLC locality: Tbilisi (in admin1 51)
		row({
			0: "611717",
			1: "Tbilisi",
			2: "Tbilisi",
			4: "41.69",
			5: "44.83",
			6: "P",
			7: "PPLC",
			8: "GE",
			10: "51",
			14: "1049498",
		}),
	].join("\n")

	await writeLocalFile(lines, dir.resolve("GE.txt"))

	db = DatabaseClient.temp<WOFDatabase>()

	db.exec(
		`CREATE TABLE spr (id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
		 latitude REAL, longitude REAL, min_latitude REAL, min_longitude REAL, max_latitude REAL, max_longitude REAL,
		 is_current INTEGER, is_deprecated INTEGER, is_ceased INTEGER, is_superseded INTEGER, is_superseding INTEGER, lastmodified INTEGER)`
	)

	db.exec(
		`CREATE TABLE names (id INTEGER, name TEXT, placetype TEXT, country TEXT, language TEXT, privateuse TEXT, official INTEGER, lastmodified INTEGER)`
	)

	db.exec(`CREATE TABLE ancestors (id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT, lastmodified INTEGER)`)
	db.exec(`CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER)`)

	await ingestGeonamesAliases(db, ["GE"], dir.path, () => {}, { adminForCountries: new Set(["GE"]) })
})

afterAll(() => {
	db.destroy()
	dir[Symbol.asyncDispose]()
})

test("folds the country (PCLI) and region (ADM1) as admin spr rows", () => {
	const country = db
		.prepare("SELECT name, placetype, country FROM spr WHERE placetype='country' AND country='GE'")
		.get() as Row

	const region = db.prepare("SELECT name, placetype FROM spr WHERE placetype='region' AND country='GE'").get() as Row

	expect(country?.name).toBe("Georgia")
	expect(region?.name).toBe("Tbilisi")
})

test("links the locality → region → country ancestry so parentID scoping reaches it", () => {
	const loc = db.prepare("SELECT id, parent_id FROM spr WHERE placetype='locality' AND country='GE'").get() as Row
	const region = db.prepare("SELECT id FROM spr WHERE placetype='region' AND country='GE'").get() as Row
	const country = db.prepare("SELECT id FROM spr WHERE placetype='country' AND country='GE'").get() as Row

	// Locality is parented to its region; the ancestor chain carries both region and country.
	expect(loc.parent_id).toBe(region.id)

	const ancestorIDs = db
		.prepare("SELECT ancestor_id FROM ancestors WHERE id = ? ORDER BY ancestor_id")
		.all(loc.id!)
		.map((r) => (r as Row).ancestor_id)

	expect(ancestorIDs).toContain(region.id)
	expect(ancestorIDs).toContain(country.id)

	// The region itself ancestors to the country (so a region→country query works too).
	const regionAnc = db
		.prepare("SELECT ancestor_id FROM ancestors WHERE id = ?")
		.all(region.id!)
		.map((r) => (r as Row).ancestor_id)

	expect(regionAnc).toContain(country.id)
})

test("default (no includeAdmin) stays localities-only with no admin rows — byte-stable", async () => {
	await using db2 = DatabaseClient.temp<WOFDatabase>()

	db2.exec(`CREATE TABLE spr (id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
		 latitude REAL, longitude REAL, min_latitude REAL, min_longitude REAL, max_latitude REAL, max_longitude REAL,
		 is_current INTEGER, is_deprecated INTEGER, is_ceased INTEGER, is_superseded INTEGER, is_superseding INTEGER, lastmodified INTEGER)`)

	db2.exec(
		`CREATE TABLE names (id INTEGER, name TEXT, placetype TEXT, country TEXT, language TEXT, privateuse TEXT, official INTEGER, lastmodified INTEGER)`
	)

	db2.exec(`CREATE TABLE ancestors (id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT, lastmodified INTEGER)`)
	db2.exec(`CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER)`)
	await ingestGeonamesAliases(db2, ["GE"], dir.path, () => {})

	expect((db2.prepare("SELECT COUNT(*) n FROM spr WHERE placetype IN ('country','region')").get() as Row).n).toBe(0)

	// No LINKAGE — the point of the admin check. The self row is not linkage: `populateAncestors` writes
	// one for every spr row, so withholding it just made the fold-on-copy path disagree with a full build
	// by exactly the non-gap localities (#1514).
	expect(
		(db2.prepare("SELECT COUNT(*) n FROM ancestors WHERE ancestor_placetype IN ('country','region')").get() as Row).n
	).toBe(0)

	expect((db2.prepare("SELECT COUNT(*) n FROM ancestors WHERE id = ancestor_id").get() as Row).n).toBe(1)
	expect((db2.prepare("SELECT parent_id FROM spr WHERE placetype='locality'").get() as Row).parent_id).toBe(-1)
})

test("recognizes a PCLS special-administrative-region as the country (HK/MO/PS)", async () => {
	await using dDirectory = await temporaryDirectory("geonames-pcls-")
	const d = dDirectory.path

	await writeLocalTextFile(
		[
			row({ 0: "1819730", 1: "Hong Kong", 2: "Hong Kong", 4: "22.3", 5: "114.2", 6: "A", 7: "PCLS", 8: "HK" }),
			row({
				0: "1819729",
				1: "Hong Kong",
				2: "Hong Kong",
				4: "22.28",
				5: "114.16",
				6: "P",
				7: "PPLC",
				8: "HK",
				14: "7012738",
			}),
		].join("\n"),
		join(d, "HK.txt")
	)

	using hk = DatabaseClient.temp<WOFDatabase>()

	hk.exec(`CREATE TABLE spr (id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
		 latitude REAL, longitude REAL, min_latitude REAL, min_longitude REAL, max_latitude REAL, max_longitude REAL,
		 is_current INTEGER, is_deprecated INTEGER, is_ceased INTEGER, is_superseded INTEGER, is_superseding INTEGER, lastmodified INTEGER)`)

	hk.exec(
		`CREATE TABLE names (id INTEGER, name TEXT, placetype TEXT, country TEXT, language TEXT, privateuse TEXT, official INTEGER, lastmodified INTEGER)`
	)

	hk.exec(`CREATE TABLE ancestors (id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT, lastmodified INTEGER)`)
	hk.exec(`CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER)`)
	await ingestGeonamesAliases(hk, ["HK"], d, () => {}, { adminForCountries: new Set(["HK"]) })

	// PCLS is a country-level code; the fold must seat Hong Kong as the country (not skip it like pre-PCL*).
	expect((hk.prepare("SELECT name FROM spr WHERE placetype='country' AND country='HK'").get() as Row)?.name).toBe(
		"Hong Kong"
	)
})
