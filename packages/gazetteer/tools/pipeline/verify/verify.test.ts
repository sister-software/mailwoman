// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { expect, test } from "vitest"

import { enrichAdmin } from "#tools/pipeline/admin/enrich"
import { buildFTS } from "#tools/pipeline/fts"
import { type VerifyBaseline, verifyAdmin } from "#tools/pipeline/verify"

const TINY_BASELINE: VerifyBaseline = {
	requiredNodes: { TL: ["country", "region"] },
	minRows: 1,
	minCountries: 1,
}

async function fixtureDB(): Promise<DatabaseClient<WOFDatabase>> {
	const { createUnifiedSchema } = await import("@mailwoman/resolver-wof-sqlite/schema/unified")
	const db = DatabaseClient.temp<WOFDatabase>()
	await createUnifiedSchema(db)

	// Non-zero coords + real extents — the place_bbox R*Tree insert skips all-zero placeholder rows.
	const ins = db.prepare(
		"INSERT INTO spr (id, parent_id, name, placetype, country, latitude, longitude, min_latitude, min_longitude, max_latitude, max_longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, 0, 0, 0)"
	)

	ins.run(1, -1, "Testland", "country", "TL", 2, 2, 1, 1, 3, 3)
	ins.run(2, 1, "Testregion", "region", "TL", 1.5, 1.5, 1, 1, 2, 2)
	ins.run(3, 2, "Testtown", "locality", "TL", 1.5, 1.5, 1.4, 1.4, 1.6, 1.6)
	// The US spot-check target (VT→Vermont).
	// Every real admin DB contains US.
	ins.run(85_688_763, -1, "Vermont", "region", "US", 44, -72.7, 42.7, -73.4, 45, -71.5)
	await enrichAdmin(db)
	await buildFTS(db)

	return db
}

test("verifyAdmin passes a complete fixture", async () => {
	using db = await fixtureDB()
	const r = verifyAdmin(db, TINY_BASELINE)

	expect(r.checks.map((c) => `${c.check}:${c.ok}`)).toEqual([
		"node-census:true",
		"coverage-floor:true",
		"region-abbrevs:true",
		"place-abbr:true",
		"names-source:true",
		"concordances-source:true",
		"fts-bbox:true",
		"point-in-extent:true",
		"bbox-extents:true",
	])

	expect(r.ok).toBe(true)
})

test("verifyAdmin fails point-in-extent when a located place lies outside its extent or records none (#3164)", async () => {
	using db = await fixtureDB()
	db.exec("UPDATE spr SET latitude = 1.7 WHERE id = 3")

	db.exec(
		"INSERT INTO spr (id, name, placetype, country, latitude, longitude) VALUES (4, 'Pointville', 'locality', 'TL', 1.2, 1.2)"
	)

	// The unlocated sentinel: no point and no extent, so it needs neither.
	db.exec("INSERT INTO spr (id, name, placetype, country) VALUES (5, 'Nowhere', 'localadmin', 'XX')")

	const check = verifyAdmin(db, TINY_BASELINE).checks.find((c) => c.check === "point-in-extent")!

	expect(check.ok).toBe(false)
	expect(check.detail).toBe("1 located places lie outside their extent, 1 record no extent")
})

test("verifyAdmin fails names-source when a writer left a row's source empty", async () => {
	using db = await fixtureDB()
	db.exec("INSERT INTO names (id, name, placetype, country, language) VALUES (3, 'Testburg', 'locality', 'TL', '')")
	const r = verifyAdmin(db, TINY_BASELINE)
	const check = r.checks.find((c) => c.check === "names-source")!

	expect(r.ok).toBe(false)
	expect(check.detail).toBe("1 rows state no source")
})

test("verifyAdmin fails node-census when a required country node is missing (#1026)", async () => {
	using db = await fixtureDB()
	db.exec("DELETE FROM spr WHERE id = 1") // drop Testland's country node
	const r = verifyAdmin(db, TINY_BASELINE)
	expect(r.ok).toBe(false)
	const census = r.checks.find((c) => c.check === "node-census")!
	expect(census.ok).toBe(false)
	expect(census.detail).toContain("TL/country")
})

test("verifyAdmin fails place-abbr when the join table is missing (the #1015 missed-step class)", async () => {
	using db = await fixtureDB()
	db.exec("DROP TABLE place_abbr")
	const r = verifyAdmin(db, TINY_BASELINE)
	expect(r.ok).toBe(false)
	expect(r.checks.find((c) => c.check === "place-abbr")!.ok).toBe(false)
})
