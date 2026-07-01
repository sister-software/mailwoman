/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #741 postcode-keyed postal-city side-index on the candidate backend. Builds a fixture
 *   candidate.db (via `buildCandidateTable`) with Nashville (high pop) + a far Antioch, CA
 *   distractor, attaches a `postal_city_candidate` row (`antioch`, 37013 → Nashville), and pins the
 *   probe's behaviour: an exact `(name_key, postcode)` hit resolves the postal city to its
 *   geographic locality; a bare query (no postcode), a postcode miss, a non-locality request, and a
 *   candidate.db WITHOUT the side-index are all untouched (byte-stable).
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { buildCandidateTable } from "./build-candidate.js"
import { WOFCandidateTableLookup } from "./candidate-lookup.js"
import {
	createPostalCityCandidateTable,
	POSTAL_CITY_CANDIDATE_TABLE,
	type PostalCityCandidateDatabase,
} from "./postal-city-candidate-schema.js"

let scratch: string
let candidatePath: string

function buildFixtureAdmin(path: string): void {
	const db = new DatabaseSync(path)
	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL,
			min_latitude REAL, min_longitude REAL, max_latitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER
		);
		CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER NOT NULL DEFAULT 0);
		CREATE TABLE place_search (wof_id INTEGER PRIMARY KEY, alt_names TEXT);
		CREATE TABLE place_abbr (id INTEGER PRIMARY KEY, abbr TEXT);
		CREATE TABLE ancestors (id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT);

		-- Nashville (the geographic locality 37013 sits in) and a far Antioch, CA distractor.
		INSERT INTO spr VALUES (1, 'Nashville', 'locality', 'US', 36.17, -86.78, 36.0, -87.0, 36.4, -86.5, -1, 0);
		INSERT INTO spr VALUES (2, 'Antioch', 'locality', 'US', 38.0, -121.8, 37.9, -121.9, 38.1, -121.7, -1, 0);
		INSERT INTO place_population VALUES (1, 700000);
		INSERT INTO place_population VALUES (2, 117000);
	`)
	db.close()
}

/** Attach the #741 side-index with one edge: the postal city "Antioch" at 37013 → Nashville (id 1). */
async function attachPostalCityIndex(path: string): Promise<void> {
	const raw = new DatabaseSync(path)
	const kdb = new DatabaseClient<PostalCityCandidateDatabase>({ database: raw })
	await createPostalCityCandidateTable(kdb)
	await kdb
		.insertInto(POSTAL_CITY_CANDIDATE_TABLE)
		.values({
			name_key: "antioch",
			postcode: "37013",
			spr_id: 1,
			name: "Nashville",
			latitude: 36.17,
			longitude: -86.78,
		})
		.execute()
	await kdb.destroy() // closes the underlying `raw` handle
}

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "mailwoman-pcc-"))
	const input = join(scratch, "admin.db")
	candidatePath = join(scratch, "candidate.db")
	buildFixtureAdmin(input)
	await buildCandidateTable({ input, output: candidatePath, postcodes: [] })
})

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true }).catch(() => {})
})

describe("WOFCandidateTableLookup postal-city side-index (#741)", () => {
	test("WITHOUT the side-index, a postal-city query resolves to the far distractor (the gap)", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			const hits = await lk.findPlace({ text: "Antioch", placetype: "locality", postcode: "37013", country: "US" })
			expect(hits[0]!.name).toBe("Antioch") // the CA distractor — no side-index to redirect
			expect(hits[0]!.lat).toBeCloseTo(38.0, 1)
		} finally {
			lk.close()
		}
	})

	test("WITH the side-index, an exact (name_key, postcode) hit resolves to the geographic locality", async () => {
		await attachPostalCityIndex(candidatePath)
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			const hits = await lk.findPlace({ text: "Antioch", placetype: "locality", postcode: "37013", country: "US" })
			expect(hits).toHaveLength(1)
			expect(hits[0]!.name).toBe("Nashville")
			expect(hits[0]!.lat).toBeCloseTo(36.17, 1)
			expect(hits[0]!.exactMatch).toBe(true)
		} finally {
			lk.close()
		}
	})

	test("a BARE query (no postcode) is untouched — bare 'Antioch' still resolves to the CA distractor", async () => {
		await attachPostalCityIndex(candidatePath)
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			// No postcode → the side-index probe is gated off → normal population-first ranking. There is
			// no Nashville-keyed "antioch" row in the main table, so the real Antioch wins. The alias never
			// leaks into bare-name resolution.
			const hits = await lk.findPlace({ text: "Antioch", placetype: "locality", country: "US" })
			expect(hits[0]!.name).toBe("Antioch")
			expect(hits[0]!.lat).toBeCloseTo(38.0, 1)
		} finally {
			lk.close()
		}
	})

	test("a postcode NOT in the side-index falls through to the normal probe", async () => {
		await attachPostalCityIndex(candidatePath)
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			const hits = await lk.findPlace({ text: "Antioch", placetype: "locality", postcode: "99999", country: "US" })
			expect(hits[0]!.name).toBe("Antioch") // 99999 not in the index → normal ranking → CA distractor
		} finally {
			lk.close()
		}
	})

	test("a NON-locality request (region) does not consult the locality side-index", async () => {
		await attachPostalCityIndex(candidatePath)
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			// region query + postcode must NOT return the locality alias (Nashville).
			const hits = await lk.findPlace({ text: "Antioch", placetype: "region", postcode: "37013", country: "US" })
			expect(hits.every((h) => h.name !== "Nashville")).toBe(true)
		} finally {
			lk.close()
		}
	})

	test("a candidate.db WITHOUT the side-index is byte-stable (no probe, no crash)", async () => {
		// candidatePath has NO postal_city_candidate table here (attach not called).
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			const hits = await lk.findPlace({ text: "Antioch", placetype: "locality", postcode: "37013", country: "US" })
			expect(hits[0]!.name).toBe("Antioch") // unchanged from pre-#741
		} finally {
			lk.close()
		}
	})
})
