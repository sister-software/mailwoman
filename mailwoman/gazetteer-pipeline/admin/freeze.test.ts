/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */
import { DatabaseSync } from "node:sqlite"

import { createUnifiedSchema } from "@mailwoman/resolver-wof-sqlite/unified-schema"
import { expect, test } from "vitest"

import { freezeAdmin } from "./freeze.js"

test("freezeAdmin builds the ancestors closure, the ancestors_by_id index, and passes integrity", async () => {
	const db = new DatabaseSync(":memory:")
	await createUnifiedSchema(db)
	const ins = db.prepare(
		"INSERT INTO spr (id, parent_id, name, placetype, country, latitude, longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified) VALUES (?, ?, ?, ?, ?, 0, 0, 1, 0, 0, 0, 0, 0)"
	)
	ins.run(1, -1, "Testland", "country", "TL")
	ins.run(2, 1, "Region", "region", "TL")
	ins.run(3, 2, "Town", "locality", "TL")

	const r = await freezeAdmin(db) // no dataDir → the −4 backfill is skipped (fixture has no geojson)
	expect(r.ancestorRows).toBeGreaterThan(0)
	// The locality's closure reaches its region AND country.
	expect(
		(db.prepare("SELECT COUNT(*) n FROM ancestors WHERE id = 3 AND ancestor_id != 3").get() as { n: number }).n
	).toBe(2)
	expect(
		db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ancestors_by_id'").get()
	).toBeTruthy()
	db.close()
})
