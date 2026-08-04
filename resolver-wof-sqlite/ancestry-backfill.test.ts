/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { afterAll, beforeAll, expect, test } from "vitest"

import { backfillAncestorsFromHierarchy, discoverAdminDataRoots } from "./ancestry-backfill.ts"

let root: string

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "ancestry-backfill-"))
	// Nested lab layout: <root>/whosonfirst-data/whosonfirst-data-admin-us/data
	mkdirSync(join(root, "whosonfirst-data", "whosonfirst-data-admin-us", "data"), { recursive: true })
	// Flat layout: <root>/whosonfirst-data-admin-gb/data
	mkdirSync(join(root, "whosonfirst-data-admin-gb", "data"), { recursive: true })
	// A non-WOF sibling dir that must be ignored
	mkdirSync(join(root, "some-other-repo", "data"), { recursive: true })
	// A `data` dir buried too deep (depth 3+) that must NOT be discovered
	mkdirSync(join(root, "whosonfirst-data", "nested", "deeper", "data"), { recursive: true })
})

afterAll(() => {
	rmSync(root, { recursive: true, force: true })
})

test("discoverAdminDataRoots: finds nested + flat whosonfirst data roots, skips non-WOF + too-deep", () => {
	const roots = discoverAdminDataRoots(root)

	expect(roots).toContain(join(root, "whosonfirst-data", "whosonfirst-data-admin-us", "data"))
	expect(roots).toContain(join(root, "whosonfirst-data-admin-gb", "data"))
	// non-WOF sibling is not traversed (its name doesn't start with whosonfirst-data)
	expect(roots).not.toContain(join(root, "some-other-repo", "data"))
	// `nested/deeper/data` sits at depth 3 from root — beyond the 2-level cap
	expect(roots).not.toContain(join(root, "whosonfirst-data", "nested", "deeper", "data"))
})

test("discoverAdminDataRoots: missing root yields empty list, never throws", () => {
	expect(discoverAdminDataRoots(join(root, "does-not-exist"))).toEqual([])
})

test("backfillAncestorsFromHierarchy: inserts wof:hierarchy ancestors for only-self places, idempotent", () => {
	const db = new DatabaseSync(":memory:")
	db.exec("CREATE TABLE spr (id INTEGER PRIMARY KEY, placetype TEXT)")
	db.exec("CREATE TABLE ancestors (id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT, lastmodified INTEGER)")

	// A multi-parent locality (parent_id=-4 in real WOF) — only-self ancestry, must be repaired.
	const orphanID = 85_977_539
	db.prepare("INSERT INTO spr (id, placetype) VALUES (?, 'locality')").run(orphanID)
	db.prepare("INSERT INTO ancestors VALUES (?, ?, 'locality', 0)").run(orphanID, orphanID) // self only
	// A country (top-level) with only-self ancestry — must be skipped, not queried for geojson.
	db.prepare("INSERT INTO spr (id, placetype) VALUES (?, 'country')").run(85_633_793)
	db.prepare("INSERT INTO ancestors VALUES (?, ?, 'country', 0)").run(85_633_793, 85_633_793)

	// Source geojson with a populated wof:hierarchy (region + country), even though parent_id is -4.
	const dataRoot = join(root, "whosonfirst-data", "whosonfirst-data-admin-us", "data")
	mkdirSync(join(dataRoot, "859", "775", "39"), { recursive: true })

	writeFileSync(
		join(dataRoot, "859", "775", "39", `${orphanID}.geojson`),
		JSON.stringify({
			properties: {
				"wof:parent_id": -4,
				"wof:hierarchy": [
					{ locality_id: orphanID, region_id: 85_688_543, country_id: 85_633_793 },
					{ locality_id: orphanID, region_id: 85_688_543, county_id: 102_081_863 },
				],
			},
		})
	)

	const result = backfillAncestorsFromHierarchy(db, [dataRoot])
	// region + country + county = 3 distinct ancestors across branches (self/locality excluded).
	expect(result.placesFixed).toBe(1)
	expect(result.rowsAdded).toBe(3)

	const ancestorIds = db
		.prepare("SELECT ancestor_id FROM ancestors WHERE id = ? AND ancestor_id != ? ORDER BY ancestor_id")
		.all(orphanID, orphanID)
		.map((r) => (r as { ancestor_id: number }).ancestor_id)

	expect(ancestorIds).toEqual([85_633_793, 85_688_543, 102_081_863].toSorted((a, b) => a - b))

	// Re-run: idempotent — already-present rows are not duplicated.
	const again = backfillAncestorsFromHierarchy(db, [dataRoot])
	expect(again.rowsAdded).toBe(0)
	expect(again.placesFixed).toBe(0)

	db.close()
})

test("backfillAncestorsFromHierarchy: repairs a borough that INHERITED its parent's dead end (#1445)", () => {
	const db = new DatabaseSync(":memory:")
	db.exec("CREATE TABLE spr (id INTEGER PRIMARY KEY, placetype TEXT)")
	db.exec("CREATE TABLE ancestors (id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT, lastmodified INTEGER)")

	// New York City: the multi-parent locality, ALREADY repaired by an earlier pass — it has a full
	// ancestor set, so it is not a candidate this time.
	const nycID = 85_977_539
	const brooklynID = 421_205_765
	const nyStateID = 85_688_543
	const kingsCountyID = 102_082_361
	const usID = 85_633_793

	db.prepare("INSERT INTO spr (id, placetype) VALUES (?, 'locality')").run(nycID)

	for (const [aid, pt] of [
		[nycID, "locality"],
		[usID, "country"],
		[nyStateID, "region"],
		[kingsCountyID, "county"],
	] as Array<[number, string]>) {
		db.prepare("INSERT INTO ancestors VALUES (?, ?, ?, 0)").run(nycID, aid, pt)
	}

	// Brooklyn: parent_id points at NYC, so the parent_id closure produced exactly self + NYC and
	// stopped — NYC's own parent_id is the -4 sentinel. TWO ancestor rows, which the previous
	// "<= 1 ancestor row" candidate test excluded, leaving the borough with no region ancestor.
	db.prepare("INSERT INTO spr (id, placetype) VALUES (?, 'borough')").run(brooklynID)
	db.prepare("INSERT INTO ancestors VALUES (?, ?, 'borough', 0)").run(brooklynID, brooklynID)
	db.prepare("INSERT INTO ancestors VALUES (?, ?, 'locality', 0)").run(brooklynID, nycID)

	const dataRoot = join(root, "whosonfirst-data", "whosonfirst-data-admin-us", "data")
	mkdirSync(join(dataRoot, "421", "205", "765"), { recursive: true })

	// Brooklyn's real source hierarchy — the whole chain is present even though parent_id is not -4.
	writeFileSync(
		join(dataRoot, "421", "205", "765", `${brooklynID}.geojson`),
		JSON.stringify({
			properties: {
				"wof:parent_id": nycID,
				"wof:hierarchy": [
					{
						borough_id: brooklynID,
						continent_id: 102_191_575,
						country_id: usID,
						county_id: kingsCountyID,
						locality_id: nycID,
						region_id: nyStateID,
					},
				],
			},
		})
	)

	const result = backfillAncestorsFromHierarchy(db, [dataRoot])

	// continent + country + county + region = 4 new rows. Self is excluded, and the locality row
	// (NYC) is already present, so neither is re-inserted.
	expect(result.placesFixed).toBe(1)
	expect(result.rowsAdded).toBe(4)

	const byPlacetype = db
		.prepare("SELECT ancestor_placetype AS pt, ancestor_id AS aid FROM ancestors WHERE id = ? ORDER BY pt")
		.all(brooklynID) as Array<{ pt: string; aid: number }>

	// The region ancestor is the whole point: without it the resolver's region-descendant filter
	// cannot reach the borough, and "Brooklyn, NY" resolves to a Jefferson County hamlet instead.
	expect(byPlacetype.find((row) => row.pt === "region")?.aid).toBe(nyStateID)
	expect(byPlacetype.find((row) => row.pt === "county")?.aid).toBe(kingsCountyID)
	expect(byPlacetype.find((row) => row.pt === "country")?.aid).toBe(usID)
	expect(byPlacetype.filter((row) => row.aid === nycID)).toHaveLength(1)

	// NYC itself was never a candidate — it already had a country ancestor.
	expect(db.prepare("SELECT COUNT(*) AS n FROM ancestors WHERE id = ?").get(nycID)).toEqual({ n: 4 })

	const again = backfillAncestorsFromHierarchy(db, [dataRoot])
	expect(again.rowsAdded).toBe(0)

	db.close()
})

test("backfillAncestorsFromHierarchy: leaves a place whose SOURCE hierarchy stops short alone", () => {
	const db = new DatabaseSync(":memory:")
	db.exec("CREATE TABLE spr (id INTEGER PRIMARY KEY, placetype TEXT)")
	db.exec("CREATE TABLE ancestors (id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT, lastmodified INTEGER)")

	// Fatumafuti, American Samoa: WOF itself gives it {country_id, locality_id} and no region. The
	// artifact matching that is correct, not truncated — and because it HAS a country ancestor it is
	// not a candidate at all, so no geojson probe happens for it.
	const id = 101_734_391
	db.prepare("INSERT INTO spr (id, placetype) VALUES (?, 'locality')").run(id)
	db.prepare("INSERT INTO ancestors VALUES (?, ?, 'locality', 0)").run(id, id)
	db.prepare("INSERT INTO ancestors VALUES (?, ?, 'country', 0)").run(id, 85_633_793)

	const dataRoot = join(root, "whosonfirst-data", "whosonfirst-data-admin-us", "data")
	const result = backfillAncestorsFromHierarchy(db, [dataRoot])

	expect(result.placesFixed).toBe(0)
	expect(result.rowsAdded).toBe(0)
	expect(result.noGeojson).toBe(0)

	db.close()
})
