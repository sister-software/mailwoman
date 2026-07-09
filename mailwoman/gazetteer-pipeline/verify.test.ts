/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */
import { DatabaseSync } from "node:sqlite"

import { expect, test } from "vitest"

import { enrichAdmin } from "./admin/enrich.ts"
import { buildFTS } from "./fts.ts"
import { REVERSE_PANEL_CASES, type VerifyBaseline, verifyAdmin } from "./verify.ts"

const TINY_BASELINE: VerifyBaseline = {
	requiredNodes: { TL: ["country", "region"] },
	minRows: 1,
	minCountries: 1,
}

async function fixtureDB(): Promise<DatabaseSync> {
	const { createUnifiedSchema } = await import("@mailwoman/resolver-wof-sqlite/unified-schema")
	const db = new DatabaseSync(":memory:")
	await createUnifiedSchema(db)
	// Non-zero coords + real extents — the place_bbox R*Tree insert skips all-zero placeholder rows.
	const ins = db.prepare(
		"INSERT INTO spr (id, parent_id, name, placetype, country, latitude, longitude, min_latitude, min_longitude, max_latitude, max_longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, 0, 0, 0)"
	)
	ins.run(1, -1, "Testland", "country", "TL", 2, 2, 1, 1, 3, 3)
	ins.run(2, 1, "Testregion", "region", "TL", 1.5, 1.5, 1, 1, 2, 2)
	ins.run(3, 2, "Testtown", "locality", "TL", 1.5, 1.5, 1.4, 1.4, 1.6, 1.6)
	// The US spot-check target (VT→Vermont) — every real admin DB carries US.
	ins.run(85688763, -1, "Vermont", "region", "US", 44.0, -72.7, 42.7, -73.4, 45.0, -71.5)
	enrichAdmin(db)
	await buildFTS(db)

	return db
}

test("verifyAdmin passes a complete fixture", async () => {
	const db = await fixtureDB()
	const r = verifyAdmin(db, TINY_BASELINE)
	expect(r.checks.map((c) => `${c.check}:${c.ok}`)).toEqual([
		"node-census:true",
		"coverage-floor:true",
		"region-abbrevs:true",
		"place-abbr:true",
		"fts-bbox:true",
		"bbox-extents:true",
	])
	expect(r.ok).toBe(true)
	db.close()
})

test("verifyAdmin fails node-census when a required country node is missing (#1026)", async () => {
	const db = await fixtureDB()
	db.exec("DELETE FROM spr WHERE id = 1") // drop Testland's country node
	const r = verifyAdmin(db, TINY_BASELINE)
	expect(r.ok).toBe(false)
	const census = r.checks.find((c) => c.check === "node-census")!
	expect(census.ok).toBe(false)
	expect(census.detail).toContain("TL/country")
	db.close()
})

test("verifyAdmin fails place-abbr when the join table is missing (the #1015 missed-step class)", async () => {
	const db = await fixtureDB()
	db.exec("DROP TABLE place_abbr")
	const r = verifyAdmin(db, TINY_BASELINE)
	expect(r.ok).toBe(false)
	expect(r.checks.find((c) => c.check === "place-abbr")!.ok).toBe(false)
	db.close()
})

test("the reverse panel covers the #1015 failure cases", () => {
	expect(REVERSE_PANEL_CASES.length).toBeGreaterThanOrEqual(15)
	const labels = REVERSE_PANEL_CASES.map(([label]) => label)

	for (const must of ["Brussels", "Antwerpen", "Gent", "Basel"]) {
		expect(labels.some((l) => l.includes(must))).toBe(true)
	}
})
