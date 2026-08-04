/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { createUnifiedSchema } from "@mailwoman/resolver-wof-sqlite/unified-schema"
import { expect, test } from "vitest"

import { fillPostcodeCentroids } from "./centroid-fills.ts"

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

test("GeoNames postal names each postcode's delivery city, including territories filed under their own ISO code", async () => {
	// A delivery city is not the geographic locality: 11201 is Brooklyn inside the locality New York,
	// and Queens uses neighbourhood names rather than the borough. Both shapes are here on purpose.
	const dir = mkdtempSync(join(tmpdir(), "centroid-names-"))
	const shardPath = join(dir, "postalcode-us.db")
	const shard = new DatabaseSync(shardPath)

	await createUnifiedSchema(shard)

	const ins = shard.prepare(
		"INSERT INTO spr (id, parent_id, name, placetype, country, latitude, longitude, min_latitude, min_longitude, max_latitude, max_longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0)"
	)

	ins.run(1, -1, "11201", "postalcode", "US", 40.69, -73.99) // already placed, still nameless
	ins.run(2, -1, "11375", "postalcode", "US", 40.72, -73.85) // Queens: a neighbourhood delivery city
	ins.run(3, -1, "00601", "postalcode", "US", 0, 0) // Puerto Rico, filed as US in WOF
	shard.close()

	// GeoNames files a US territory under PR, not US. The shard files it under US. Reading only `US`
	// rows leaves every territory postcode unnamed — 149 of them against the 2024 Census ZCTA list.
	const geonamesDir = join(dir, "geonames-postal")

	mkdirSync(geonamesDir, { recursive: true })

	writeFileSync(
		join(geonamesDir, "US.txt"),
		[
			"US\t11201\tBrooklyn\tNew York\tNY\tKings\t047\t\t\t40.694\t-73.9903\t4",
			"US\t11375\tForest Hills\tNew York\tNY\tQueens\t081\t\t\t40.7229\t-73.8473\t4",
			"PR\t00601\tAdjuntas\tPuerto Rico\tPR\tAdjuntas\t001\t\t\t18.1801\t-66.7522\t4",
		].join("\n")
	)

	const db = new DatabaseSync(shardPath)

	const r = await fillPostcodeCentroids(db, { geonamesDir })

	expect(r.geonamesNames).toBe(3)

	const named = (postcode: string) =>
		(
			db
				.prepare(
					"SELECT n.name AS name FROM spr s JOIN names n ON n.id = s.id WHERE s.placetype = 'postalcode' AND s.name = ?"
				)
				.all(postcode) as Array<{ name: string }>
		).map((row) => row.name)

	expect(named("11201")).toEqual(["Brooklyn"])
	expect(named("11375")).toEqual(["Forest Hills"])
	// The country-alias case. Without it this is [] and the postcode also keeps its (0,0) placeholder.
	expect(named("00601")).toEqual(["Adjuntas"])

	const pr = db.prepare("SELECT latitude FROM spr WHERE id = 3").get() as { latitude: number }

	expect(pr.latitude).toBeCloseTo(18.1801, 3)

	db.close()
})
