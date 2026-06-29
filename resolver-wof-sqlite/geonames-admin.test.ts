/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #267 — `ingestGeonamesAliases({ includeAdmin: true })` folds the GeoNames A-class admin (PCLI country
 *   + ADM1 regions) alongside the P-class localities and links the locality→region→country ancestry, so
 *   `parentId` scoping and adminCoherence reach the gap countries ("Tbilisi, GE" can resolve).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { afterAll, beforeAll, expect, test } from "vitest"

import { ingestGeonamesAliases } from "./geonames-aliases.js"

let dir: string
let db: DatabaseSync

// One GeoNames row: 19 tab-separated columns (id, name, ascii, alt, lat, lon, fclass, fcode, country, cc2,
// admin1, admin2, admin3, admin4, pop, elev, dem, tz, mod).
function row(over: Record<number, string>): string {
	const f = Array(19).fill("")
	for (const [i, v] of Object.entries(over)) f[Number(i)] = v
	return f.join("\t")
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "geonames-admin-"))
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
	writeFileSync(join(dir, "GE.txt"), lines)

	db = new DatabaseSync(":memory:")
	db.exec(
		`CREATE TABLE spr (id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
		 latitude REAL, longitude REAL, min_latitude REAL, min_longitude REAL, max_latitude REAL, max_longitude REAL,
		 is_current INTEGER, is_deprecated INTEGER, is_ceased INTEGER, is_superseded INTEGER, is_superseding INTEGER, lastmodified INTEGER)`
	)
	db.exec(
		`CREATE TABLE names (id INTEGER, name TEXT, placetype TEXT, country TEXT, language TEXT, lastmodified INTEGER)`
	)
	db.exec(`CREATE TABLE ancestors (id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT, lastmodified INTEGER)`)
	db.exec(`CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER)`)

	ingestGeonamesAliases(db, ["GE"], dir, () => {}, { adminForCountries: new Set(["GE"]) })
})

afterAll(() => {
	db.close()
	rmSync(dir, { recursive: true, force: true })
})

test("folds the country (PCLI) and region (ADM1) as admin spr rows", () => {
	const country = db
		.prepare("SELECT name, placetype, country FROM spr WHERE placetype='country' AND country='GE'")
		.get() as any
	const region = db.prepare("SELECT name, placetype FROM spr WHERE placetype='region' AND country='GE'").get() as any

	expect(country?.name).toBe("Georgia")
	expect(region?.name).toBe("Tbilisi")
})

test("links the locality → region → country ancestry so parentId scoping reaches it", () => {
	const loc = db.prepare("SELECT id, parent_id FROM spr WHERE placetype='locality' AND country='GE'").get() as any
	const region = db.prepare("SELECT id FROM spr WHERE placetype='region' AND country='GE'").get() as any
	const country = db.prepare("SELECT id FROM spr WHERE placetype='country' AND country='GE'").get() as any

	// Locality is parented to its region; the ancestor chain carries both region and country.
	expect(loc.parent_id).toBe(region.id)
	const ancestorIds = db
		.prepare("SELECT ancestor_id FROM ancestors WHERE id = ? ORDER BY ancestor_id")
		.all(loc.id)
		.map((r: any) => r.ancestor_id)
	expect(ancestorIds).toContain(region.id)
	expect(ancestorIds).toContain(country.id)
	// The region itself ancestors to the country (so a region→country query works too).
	const regionAnc = db
		.prepare("SELECT ancestor_id FROM ancestors WHERE id = ?")
		.all(region.id)
		.map((r: any) => r.ancestor_id)
	expect(regionAnc).toContain(country.id)
})

test("default (no includeAdmin) stays localities-only with no admin rows — byte-stable", () => {
	const db2 = new DatabaseSync(":memory:")
	db2.exec(`CREATE TABLE spr (id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
		 latitude REAL, longitude REAL, min_latitude REAL, min_longitude REAL, max_latitude REAL, max_longitude REAL,
		 is_current INTEGER, is_deprecated INTEGER, is_ceased INTEGER, is_superseded INTEGER, is_superseding INTEGER, lastmodified INTEGER)`)
	db2.exec(
		`CREATE TABLE names (id INTEGER, name TEXT, placetype TEXT, country TEXT, language TEXT, lastmodified INTEGER)`
	)
	db2.exec(`CREATE TABLE ancestors (id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT, lastmodified INTEGER)`)
	db2.exec(`CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER)`)
	ingestGeonamesAliases(db2, ["GE"], dir, () => {})

	expect((db2.prepare("SELECT COUNT(*) n FROM spr WHERE placetype IN ('country','region')").get() as any).n).toBe(0)
	expect((db2.prepare("SELECT COUNT(*) n FROM ancestors").get() as any).n).toBe(0)
	expect((db2.prepare("SELECT parent_id FROM spr WHERE placetype='locality'").get() as any).parent_id).toBe(-1)
	db2.close()
})
