import { WOFSQLitePlaceLookup } from "@mailwoman/resolver-wof-sqlite/lookup"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Regression tests for the region-abbreviation resolution path.
 */
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

// US regions with their USPS abbreviations (what add-region-abbrevs writes into `names`), two
// same-named Sheldon towns (the Vermont one small and the Iowa one larger), and the ancestry the
// wof:hierarchy backfill restores so the region constraint can reach the descendant town.
function buildDB(): DatabaseClient<WOFDatabase> {
	const db = DatabaseClient.temp<WOFDatabase>()

	db.exec(`
		CREATE TABLE spr (id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL, min_latitude REAL, max_latitude REAL, min_longitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER);
		CREATE TABLE names (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER NOT NULL, language TEXT, name TEXT NOT NULL);
		CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER);
		CREATE TABLE ancestors (id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT, lastmodified INTEGER);
	`)

	const spr = db.prepare(
		`INSERT INTO spr (id,parent_id,name,placetype,country,latitude,longitude,min_latitude,max_latitude,min_longitude,max_longitude,is_current,is_deprecated)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,-1,0)`
	)

	// Regions (US states plus DC and a territory), with the US country node (id 1) as parent.
	spr.run(1, 0, "United States", "country", "US", 39.8, -98.6, 18, 72, -180, -66)
	spr.run(10, 1, "Vermont", "region", "US", 44, -72.7, 42.7, 45, -73.4, -71.5)
	spr.run(11, 1, "Iowa", "region", "US", 42, -93.5, 40.4, 43.5, -96.6, -90.1)
	spr.run(12, 1, "California", "region", "US", 36.7, -119.4, 32.5, 42, -124.4, -114.1)
	spr.run(13, 1, "District of Columbia", "region", "US", 38.9, -77, 38.8, 39, -77.1, -76.9)
	spr.run(14, 1, "Puerto Rico", "region", "US", 18.2, -66.5, 17.9, 18.5, -67.3, -65.2)
	// Counties. In US WOF a locality's direct parent is a county rather than the
	// region, the gap the ancestry backfill bridges.
	spr.run(20, 10, "Franklin County", "county", "US", 44.9, -72.9, 44.7, 45, -73.1, -72.5)
	spr.run(21, 11, "O'Brien County", "county", "US", 43.1, -95.6, 43, 43.3, -95.9, -95.4)
	// Two same-named localities, the bug's signature.
	spr.run(30, 20, "Sheldon", "locality", "US", 44.9, -72.95, 44.85, 44.95, -73, -72.9)
	spr.run(31, 21, "Sheldon", "locality", "US", 43.18, -95.85, 43.15, 43.2, -95.9, -95.8)
	const pop = db.prepare(`INSERT INTO place_population (id, population) VALUES (?, ?)`)
	pop.run(30, 932)
	pop.run(31, 5455) // Sheldon, IA, larger and the winner of an unconstrained population-led lookup
	// USPS abbreviations as add-region-abbrevs.ts writes them (language='abbr').
	// build-fts folds `names` into place_search.alt_names so findPlace can match them.
	const nm = db.prepare(`INSERT INTO names (id, language, name) VALUES (?, 'abbr', ?)`)
	nm.run(10, "VT")
	nm.run(11, "IA")
	nm.run(12, "CA")
	nm.run(13, "DC")
	nm.run(14, "PR")

	// Ancestry rows (self, county, region, and country) as backfill-ancestors-from-hierarchy restores them.
	const anc = db.prepare(
		`INSERT INTO ancestors (id, ancestor_id, ancestor_placetype, lastmodified) VALUES (?, ?, ?, 0)`
	)

	for (const [id, county, region] of [
		[30, 20, 10],
		[31, 21, 11],
	] as const) {
		anc.run(id, id, "locality")
		anc.run(id, county, "county")
		anc.run(id, region, "region")
		anc.run(id, 1, "country")
	}

	return db
}

let lookup: WOFSQLitePlaceLookup

beforeEach(() => {
	lookup = new WOFSQLitePlaceLookup({ database: buildDB(), buildFTS: true })
})

afterEach(() => {
	lookup[Symbol.dispose]()
})

describe("region-abbreviation resolution (#440/#441)", () => {
	it.each([
		["VT", "Vermont"],
		["IA", "Iowa"],
		["CA", "California"],
		["DC", "District of Columbia"],
		["PR", "Puerto Rico"],
	])("resolves the USPS abbreviation %s to its region (%s)", async (abbr, full) => {
		const r = await lookup.findPlace({ text: abbr, placetype: "region", country: "US" })
		expect(r[0]?.name).toBe(full)
	})

	it("constrains the locality lookup to the region's descendants — the right-state town beats a larger namesake", async () => {
		const r = await lookup.findPlace({ text: "Sheldon", placetype: "locality", parentID: 10, country: "US" })
		expect(r[0]?.id).toBe(30)
		expect(r.some((p) => p.id === 31)).toBe(false)
	})

	it("BUG CONDITION: without a region constraint the higher-population namesake wins", async () => {
		const r = await lookup.findPlace({ text: "Sheldon", placetype: "locality", country: "US" })
		expect(r[0]?.id).toBe(31)
	})

	it("the constraint reaches a place whose direct parent is a county, not the region (the ancestry-backfill case)", async () => {
		// Sheldon, VT has Franklin County (20) as its direct parent, and Vermont (10) is only an
		// ancestor. The constraint reaches it through the `ancestors` table, the linkage the
		// backfill restores for multi-parent or ambiguous-parent places such as NYC (parent_id=-4).
		const r = await lookup.findPlace({ text: "Sheldon", placetype: "locality", parentID: 10, country: "US" })
		expect(r[0]?.id).toBe(30)
	})
})
