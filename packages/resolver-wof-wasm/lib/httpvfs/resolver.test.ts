/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for the `WOFCandidateTableLookup` postal-city side-index probe in the browser
 *   candidate lookup, against a node:sqlite-backed stub of the range-read database handle.
 */

import type { CandidateDatabase } from "@mailwoman/resolver-wof-sqlite/candidate/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { describe, expect, test } from "vitest"

import { WOFCandidateTableLookup } from "#httpvfs/resolver"
import { registerOpenDatabases, stubRangeDatabase, trackDatabase } from "#test/range-database-stub"

registerOpenDatabases()

function makeDB(withSideIndex: boolean): DatabaseClient<CandidateDatabase> {
	const d = DatabaseClient.temp<CandidateDatabase>()

	d.exec(`
		CREATE TABLE country_codes (id INTEGER PRIMARY KEY, code TEXT);
		INSERT INTO country_codes VALUES (1, 'US');
		CREATE TABLE placetype_codes (id INTEGER PRIMARY KEY, placetype TEXT);
		INSERT INTO placetype_codes VALUES (1, 'locality');
		CREATE TABLE candidate (
			name_key TEXT, country_id INTEGER, region_id INTEGER, placetype_id INTEGER, neg_rank REAL, spr_id INTEGER,
			name TEXT, latitude REAL, longitude REAL, min_lat REAL, min_lon REAL, max_lat REAL, max_lon REAL,
			population INTEGER, is_primary INTEGER
		);
		-- Nashville (geographic locality 37013 sits in) + a far Antioch, CA distractor.
		INSERT INTO candidate VALUES ('nashville', 1, 0, 1, -5.84, 1, 'Nashville', 36.17, -86.78, 36.0, -87.0, 36.4, -86.5, 700000, 1);
		INSERT INTO candidate VALUES ('antioch', 1, 0, 1, -5.07, 2, 'Antioch', 38.0, -121.8, 37.9, -121.9, 38.1, -121.7, 117000, 1);
	`)

	if (withSideIndex) {
		d.exec(`
			CREATE TABLE postal_city_candidate (
				name_key TEXT NOT NULL, postcode TEXT NOT NULL, spr_id INTEGER NOT NULL,
				name TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL,
				PRIMARY KEY (name_key, postcode)
			) WITHOUT ROWID;
			INSERT INTO postal_city_candidate VALUES ('antioch', '37013', 1, 'Nashville', 36.17, -86.78);
		`)
	}

	return trackDatabase(d)
}

describe("browser WOFCandidateTableLookup postal-city side-index (#741)", () => {
	test("WITH the side-index, a postal-city + postcode resolves to the geographic locality", async () => {
		const lk = new WOFCandidateTableLookup(stubRangeDatabase(makeDB(true)))
		const hits = await lk.findPlace({ text: "Antioch", placetype: "locality", postcode: "37013", country: "US" })
		expect(hits).toHaveLength(1)
		expect(hits[0]!.name).toBe("Nashville")
		expect(hits[0]!.lat).toBeCloseTo(36.17, 1)
		expect(hits[0]!.exactMatch).toBe(true)
	})

	test("a BARE query (no postcode) is untouched — bare 'Antioch' resolves to the CA distractor", async () => {
		const lk = new WOFCandidateTableLookup(stubRangeDatabase(makeDB(true)))
		const hits = await lk.findPlace({ text: "Antioch", placetype: "locality", country: "US" })
		expect(hits[0]!.name).toBe("Antioch")
		expect(hits[0]!.lat).toBeCloseTo(38, 1)
	})

	test("a postcode NOT in the side-index falls through to the normal probe", async () => {
		const lk = new WOFCandidateTableLookup(stubRangeDatabase(makeDB(true)))
		const hits = await lk.findPlace({ text: "Antioch", placetype: "locality", postcode: "99999", country: "US" })
		expect(hits[0]!.name).toBe("Antioch")
	})

	test("a candidate.db WITHOUT the side-index is byte-stable (today's production demo)", async () => {
		const lk = new WOFCandidateTableLookup(stubRangeDatabase(makeDB(false)))
		const hits = await lk.findPlace({ text: "Antioch", placetype: "locality", postcode: "37013", country: "US" })
		expect(hits[0]!.name).toBe("Antioch")
	})
})
