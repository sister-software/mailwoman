/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Coordinate-first locality resolution (#275). When a `locality` query carries a sibling `postcode`
 *   AND a `postcode_locality` table is present, the resolver injects the postcode's containing
 *   locality (which the FTS name-match can't generate for an under-indexed small town) and
 *   soft-scores the union `0.6·S_pc + 0.3·S_name + 0.1·S_pop` with exact-name tiering. These tests
 *   pin the three behaviours: injection recovers the name-miss, exact-name tiering keeps an
 *   unambiguous city over the postcode's fine-grained Ortsteil, and the path is inert without a
 *   postcode.
 */
import { DatabaseSync } from "node:sqlite"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { WOFSqlitePlaceLookup } from "./lookup.js"

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
	spr.run(4, 0, "Muenchen", "locality", "DE", 48.14, 11.58, 48.0, 48.3, 11.4, 11.8) // ~500 km from Berlin
	// Brooklyn — a borough of New York City, added for the placetype-stamp regression guard (#523).
	spr.run(5, 0, "Brooklyn", "borough", "US", 40.65, -73.95, 40.57, 40.74, -74.04, -73.86)
	db.prepare(`INSERT INTO place_population (id, population) VALUES (?, ?)`).run(1, 3_600_000)
	db.prepare(`INSERT INTO place_population (id, population) VALUES (?, ?)`).run(4, 1_500_000)
	const pl = db.prepare(`INSERT INTO postcode_locality VALUES (?,?,?,?,?,?,?)`)
	pl.run("10115", "DE", 2, "Koepenick", "", 0.0, 1) // a Berlin postcode's centroid lands in the Ortsteil
	pl.run("08523", "DE", 3, "Plauen", "", 0.0, 1) // Plauen's postcode → Plauen
	pl.run("11201", "US", 5, "Brooklyn", "", 0.0, 1)

	// (#523) a Brooklyn postcode → the borough
	return db
}

let lookup: WOFSqlitePlaceLookup
beforeEach(() => {
	lookup = new WOFSqlitePlaceLookup({ database: buildDb(), buildFTS: true })
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

	it("flags a postcode/city conflict (wrong-for-the-city postcode) but still returns the named city", async () => {
		// "10115" is a Berlin postcode, but the parsed city is München (~500 km away) — a transposed or
		// wrong postcode. The name wins (München), but the mismatch flag fires.
		const r = await lookup.findPlace({ text: "Muenchen", placetype: "locality", postcode: "10115", country: "DE" })
		expect(r[0]?.name).toBe("Muenchen")
		expect(r[0]?.mismatch).toBe(true)
	})

	it("does NOT flag a city-state Ortsteil as a conflict (the city is near its own borough)", async () => {
		// Berlin chosen over its borough Koepenick (~15 km) — close, so no false conflict.
		const r = await lookup.findPlace({ text: "Berlin", placetype: "locality", postcode: "10115", country: "DE" })
		expect(r[0]?.mismatch).toBeFalsy()
	})

	it("preserves the actual placetype from spr when injecting a postcode-locality candidate (#523)", async () => {
		// Brooklyn is a BOROUGH. When the postcode injection fetches it by id, the placetype must
		// come from the spr row ("borough"), not a hard-coded "locality". The placetype filter
		// expands locality→borough so the candidate passes; the assertion guards the label.
		const r = await lookup.findPlace({ text: "Brooklyn", placetype: "locality", postcode: "11201", country: "US" })
		expect(r.length).toBeGreaterThan(0)
		expect(r[0]?.placetype).toBe("borough")
	})
})
