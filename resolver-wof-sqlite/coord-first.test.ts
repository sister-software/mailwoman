/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Coordinate-first locality resolution (#275). When a `locality` query carries a sibling `postcode`
 *   AND a `postcode_locality` table is present, the resolver injects the postcode's containing locality
 *   (which the FTS name-match can't generate for an under-indexed small town) and soft-scores the union
 *   `0.6·S_pc + 0.3·S_name + 0.1·S_pop` with exact-name tiering. These tests pin the three behaviours:
 *   injection recovers the name-miss, exact-name tiering keeps an unambiguous city over the postcode's
 *   fine-grained Ortsteil, and the path is inert without a postcode.
 */
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { WofSqlitePlaceLookup } from "./lookup.js"

function buildDb(): DatabaseSync {
	const db = new DatabaseSync(":memory:")
	db.exec(`
		CREATE TABLE spr (id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL, min_latitude REAL, max_latitude REAL, min_longitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER);
		CREATE TABLE names (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER NOT NULL, language TEXT, name TEXT NOT NULL);
		CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER);
		CREATE TABLE postcode_locality (postcode TEXT, country TEXT, locality_id INTEGER, locality_name TEXT,
			aliases TEXT, distance_km REAL, is_containing INTEGER);
	`)
	const spr = db.prepare(
		`INSERT INTO spr (id,parent_id,name,placetype,country,latitude,longitude,min_latitude,max_latitude,min_longitude,max_longitude,is_current,is_deprecated)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,-1,0)`
	)
	// Berlin (unambiguous city, large pop), its Ortsteil "Koepenick" (borough-as-locality), and the
	// small Saxon town "Plauen".
	spr.run(1, 0, "Berlin", "locality", "DE", 52.52, 13.4, 52.3, 52.7, 13.0, 13.8)
	spr.run(2, 1, "Koepenick", "locality", "DE", 52.44, 13.58, 52.4, 52.5, 13.5, 13.7)
	spr.run(3, 0, "Plauen", "locality", "DE", 50.49, 12.14, 50.4, 50.6, 12.0, 12.3)
	db.prepare(`INSERT INTO place_population (id, population) VALUES (?, ?)`).run(1, 3_600_000)
	const pl = db.prepare(`INSERT INTO postcode_locality VALUES (?,?,?,?,?,?,?)`)
	pl.run("10115", "DE", 2, "Koepenick", "", 0.0, 1) // a Berlin postcode's centroid lands in the Ortsteil
	pl.run("08523", "DE", 3, "Plauen", "", 0.0, 1) // Plauen's postcode → Plauen
	return db
}

let lookup: WofSqlitePlaceLookup
beforeEach(() => {
	lookup = new WofSqlitePlaceLookup({ database: buildDb(), buildFts: true })
})
afterEach(() => {
	lookup.close()
})

describe("coordinate-first locality resolution", () => {
	it("injects the postcode's containing locality when the name-match misses it", async () => {
		// "Plaun" (a typo) won't FTS-match "Plauen"; the postcode recovers the right town.
		const r = await lookup.findPlace({ text: "Plaun", placetype: "locality", postcode: "08523", country: "DE" })
		expect(r[0]?.name).toBe("Plauen")
	})

	it("is inert without a postcode — the typo falls through to the name-match path", async () => {
		const r = await lookup.findPlace({ text: "Plaun", placetype: "locality", country: "DE" })
		expect(r[0]?.name).not.toBe("Plauen")
	})

	it("exact-name tiering keeps the unambiguous city over the postcode's Ortsteil", async () => {
		// 10115's containing locality is the Ortsteil "Koepenick", but the parsed name "Berlin" is an
		// exact match — exact-name tiering keeps Berlin ahead of the coordinate-only borough.
		const r = await lookup.findPlace({ text: "Berlin", placetype: "locality", postcode: "10115", country: "DE" })
		expect(r[0]?.name).toBe("Berlin")
	})
})
