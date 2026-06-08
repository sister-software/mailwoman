/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Regression suite for the region-abbreviation resolution path — the 2026-06-08 honest-eval
 *   headline fix (docs/articles/evals/2026-06-08-night-9-postmortem.md, #440/#441). On a
 *   leakage-free Vermont slice the resolver scored 93.7% locality name-match while 326km wrong: a
 *   region given as a USPS abbreviation ("VT") didn't resolve (WOF stores "Vermont"; the FTS had no
 *   abbreviations), so the locality lookup ran UNCONSTRAINED across the whole country and a
 *   higher-population same-named town in another state won. The fix is two data-build steps
 *   (`add-region-abbrevs.ts` puts the abbreviation into `names` → `place_search`;
 *   `backfill-ancestors-from-hierarchy.ts` gives multi-parent places their region ancestor so the
 *   region constraint can reach them).
 *
 *   These tests pin the resolver-side behaviour that fix relies on, against an in-memory fixture: (1)
 *   a USPS abbreviation in `names`/FTS resolves to its region; (2) a region `parentId` constrains
 *   the locality lookup to that region's descendants (via the `ancestors` table), so the
 *   right-state town beats a larger same-named town elsewhere; (3) the bug condition — without the
 *   constraint the higher-population namesake wins, which is exactly why region resolution has to
 *   work.
 */
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { WofSqlitePlaceLookup } from "./lookup.js"

// US regions, their USPS abbreviations (what add-region-abbrevs writes into `names`), and two
// same-named towns ("Sheldon") — the Vermont one small, the Iowa one larger — plus the ancestry
// the wof:hierarchy backfill restores so the region constraint can reach the descendant town.
function buildDb(): DatabaseSync {
	const db = new DatabaseSync(":memory:")
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
	// Regions (US states + DC + a territory) — parent is the US country node (id 1).
	spr.run(1, 0, "United States", "country", "US", 39.8, -98.6, 18.0, 72.0, -180.0, -66.0)
	spr.run(10, 1, "Vermont", "region", "US", 44.0, -72.7, 42.7, 45.0, -73.4, -71.5)
	spr.run(11, 1, "Iowa", "region", "US", 42.0, -93.5, 40.4, 43.5, -96.6, -90.1)
	spr.run(12, 1, "California", "region", "US", 36.7, -119.4, 32.5, 42.0, -124.4, -114.1)
	spr.run(13, 1, "District of Columbia", "region", "US", 38.9, -77.0, 38.8, 39.0, -77.1, -76.9)
	spr.run(14, 1, "Puerto Rico", "region", "US", 18.2, -66.5, 17.9, 18.5, -67.3, -65.2)
	// Counties — in US WOF a locality's direct parent is a county, NOT the region (the gap the
	// ancestry backfill bridges).
	spr.run(20, 10, "Franklin County", "county", "US", 44.9, -72.9, 44.7, 45.0, -73.1, -72.5)
	spr.run(21, 11, "O'Brien County", "county", "US", 43.1, -95.6, 43.0, 43.3, -95.9, -95.4)
	// Two same-named localities — the bug's signature.
	spr.run(30, 20, "Sheldon", "locality", "US", 44.9, -72.95, 44.85, 44.95, -73.0, -72.9) // Vermont (small)
	spr.run(31, 21, "Sheldon", "locality", "US", 43.18, -95.85, 43.15, 43.2, -95.9, -95.8) // Iowa (larger)
	const pop = db.prepare(`INSERT INTO place_population (id, population) VALUES (?, ?)`)
	pop.run(30, 932) // Sheldon, VT
	pop.run(31, 5455) // Sheldon, IA — larger, so it wins an unconstrained, population-led lookup
	// USPS abbreviations — what add-region-abbrevs.ts writes (language='abbr'); build-fts folds
	// `names` into place_search.alt_names so findPlace can match them.
	const nm = db.prepare(`INSERT INTO names (id, language, name) VALUES (?, 'abbr', ?)`)
	nm.run(10, "VT")
	nm.run(11, "IA")
	nm.run(12, "CA")
	nm.run(13, "DC")
	nm.run(14, "PR")
	// Ancestry — self + county + region + country (what backfill-ancestors-from-hierarchy restores).
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

let lookup: WofSqlitePlaceLookup
beforeEach(() => {
	lookup = new WofSqlitePlaceLookup({ database: buildDb(), buildFts: true })
})
afterEach(() => {
	lookup.close()
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
		// Vermont = region id 10. "Sheldon" has a Vermont town (pop 932) and a larger Iowa town
		// (pop 5455). With the region constraint the Iowa town is filtered out (not a descendant of
		// Vermont), so the correct Vermont Sheldon wins despite its smaller population.
		const r = await lookup.findPlace({ text: "Sheldon", placetype: "locality", parentId: 10, country: "US" })
		expect(r[0]?.id).toBe(30)
		expect(r.some((p) => p.id === 31)).toBe(false)
	})

	it("BUG CONDITION: without a region constraint the higher-population namesake wins", async () => {
		// This is the failure the abbreviation fix exists to prevent: with no resolved region to
		// constrain the lookup, population leads and the (wrong-state) Iowa Sheldon outranks Vermont's.
		const r = await lookup.findPlace({ text: "Sheldon", placetype: "locality", country: "US" })
		expect(r[0]?.id).toBe(31)
	})

	it("the constraint reaches a place whose direct parent is a county, not the region (the ancestry-backfill case)", async () => {
		// Sheldon, VT's direct parent is Franklin County (20), not Vermont (10). The constraint still
		// reaches it through the `ancestors` table — the exact linkage the backfill restores for
		// multi/ambiguous-parent places (e.g. NYC, parent_id=-4).
		const r = await lookup.findPlace({ text: "Sheldon", placetype: "locality", parentId: 10, country: "US" })
		expect(r[0]?.id).toBe(30)
	})
})
