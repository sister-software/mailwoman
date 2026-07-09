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
	const orphanID = 85977539
	db.prepare("INSERT INTO spr (id, placetype) VALUES (?, 'locality')").run(orphanID)
	db.prepare("INSERT INTO ancestors VALUES (?, ?, 'locality', 0)").run(orphanID, orphanID) // self only
	// A country (top-level) with only-self ancestry — must be skipped, not queried for geojson.
	db.prepare("INSERT INTO spr (id, placetype) VALUES (?, 'country')").run(85633793)
	db.prepare("INSERT INTO ancestors VALUES (?, ?, 'country', 0)").run(85633793, 85633793)

	// Source geojson with a populated wof:hierarchy (region + country), even though parent_id is -4.
	const dataRoot = join(root, "whosonfirst-data", "whosonfirst-data-admin-us", "data")
	mkdirSync(join(dataRoot, "859", "775", "39"), { recursive: true })
	writeFileSync(
		join(dataRoot, "859", "775", "39", `${orphanID}.geojson`),
		JSON.stringify({
			properties: {
				"wof:parent_id": -4,
				"wof:hierarchy": [
					{ locality_id: orphanID, region_id: 85688543, country_id: 85633793 },
					{ locality_id: orphanID, region_id: 85688543, county_id: 102081863 },
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
	expect(ancestorIds).toEqual([85633793, 85688543, 102081863].sort((a, b) => a - b))

	// Re-run: idempotent — already-present rows are not duplicated.
	const again = backfillAncestorsFromHierarchy(db, [dataRoot])
	expect(again.rowsAdded).toBe(0)
	expect(again.placesFixed).toBe(0)

	db.close()
})
