/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { createUnifiedSchema } from "@mailwoman/resolver-wof-sqlite/unified-schema"
import { expect, test } from "vitest"

import { fillPostcodeCentroids } from "./centroid-fills.js"

test("parent-borrow fills a (0,0) postcode from the admin gazetteer; real coordinates untouched", async () => {
	// The staging shard: two postcodes — one placeholder (parented), one already placed.
	const dir = mkdtempSync(join(tmpdir(), "centroid-fills-"))
	const shardPath = join(dir, "postalcode-tl.db")
	const shard = new DatabaseSync(shardPath)
	await createUnifiedSchema(shard)
	const ins = shard.prepare(
		"INSERT INTO spr (id, parent_id, name, placetype, country, latitude, longitude, min_latitude, min_longitude, max_latitude, max_longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0)"
	)
	ins.run(100, 9, "1000", "postalcode", "TL", 0, 0) // placeholder → should fill from parent 9
	ins.run(101, 9, "2000", "postalcode", "TL", 5.5, 6.5) // real coordinate → must be untouched
	shard.close()

	// The admin gazetteer carrying the parent locality.
	const adminPath = join(dir, "admin.db")
	const admin = new DatabaseSync(adminPath)
	await createUnifiedSchema(admin)
	admin
		.prepare(
			"INSERT INTO spr (id, parent_id, name, placetype, country, latitude, longitude, min_latitude, min_longitude, max_latitude, max_longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified) VALUES (9, -1, 'Testtown', 'locality', 'TL', 1.25, 2.5, 1, 2, 1.5, 3, 1, 0, 0, 0, 0, 0)"
		)
		.run()
	admin.close()

	const db = new DatabaseSync(shardPath)
	const r = await fillPostcodeCentroids(db, { adminPath })
	expect(r.placedBefore).toBe(1)
	expect(r.placedAfter).toBe(2)
	expect(r.parentBorrowFixed).toBe(1)

	const filled = db.prepare("SELECT latitude, longitude FROM spr WHERE id = 100").get() as {
		latitude: number
		longitude: number
	}
	expect(filled).toEqual({ latitude: 1.25, longitude: 2.5 })
	const untouched = db.prepare("SELECT latitude, longitude FROM spr WHERE id = 101").get() as {
		latitude: number
		longitude: number
	}
	expect(untouched).toEqual({ latitude: 5.5, longitude: 6.5 })
	db.close()
})
