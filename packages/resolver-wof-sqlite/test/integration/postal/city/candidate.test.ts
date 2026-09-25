import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { buildCandidateTable } from "@mailwoman/resolver-wof-sqlite/build-candidate"
import { WOFCandidateTableLookup } from "@mailwoman/resolver-wof-sqlite/candidate-lookup"
import {
	createPostalCityCandidateTable,
	POSTAL_CITY_CANDIDATE_TABLE,
	type PostalCityCandidateDatabase,
} from "@mailwoman/resolver-wof-sqlite/postal"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilder, PathBuilderLike } from "path-ts"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

let scratch: TemporaryDirectory
let candidatePath: PathBuilder

function buildFixtureAdmin(path: PathBuilderLike): void {
	using db = new DatabaseClient<PostalCityCandidateDatabase>(path)

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
}

async function attachPostalCityIndex(path: PathBuilderLike): Promise<void> {
	using kdb = new DatabaseClient<PostalCityCandidateDatabase>(path)

	await createPostalCityCandidateTable(kdb)

	await kdb
		.insertInto(POSTAL_CITY_CANDIDATE_TABLE)
		.values({
			name_key: normalizeLocalityForKey("Antioch"),
			postcode: "37013",
			spr_id: 1,
			name: "Nashville",
			latitude: 36.17,
			longitude: -86.78,
		})
		.execute()
}

beforeEach(async () => {
	scratch = await temporaryDirectory("mailwoman-pcc-")
	const input = scratch.path("admin.db")
	candidatePath = scratch.path("candidate.db")
	buildFixtureAdmin(input)
	await buildCandidateTable({ input, output: candidatePath, postcodes: [] })
})

afterEach(async () => {
	scratch[Symbol.asyncDispose]()
})

describe("WOFCandidateTableLookup postal-city side-index", () => {
	test("WITHOUT the side-index, a postal-city query resolves to the far distractor (the gap)", async () => {
		using lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		const hits = await lk.findPlace({ text: "Antioch", placetype: "locality", postcode: "37013", country: "US" })
		expect(hits[0]!.name).toBe("Antioch")
		expect(hits[0]!.lat).toBeCloseTo(38, 1)
	})

	test("WITH the side-index, an exact (name_key, postcode) hit resolves to the geographic locality", async () => {
		await attachPostalCityIndex(candidatePath)
		using lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		const hits = await lk.findPlace({ text: "Antioch", placetype: "locality", postcode: "37013", country: "US" })
		expect(hits).toHaveLength(1)
		expect(hits[0]!.name).toBe("Nashville")
		expect(hits[0]!.lat).toBeCloseTo(36.17, 1)
		expect(hits[0]!.exactMatch).toBe(true)
	})

	test("a BARE query (no postcode) is untouched — bare 'Antioch' still resolves to the CA distractor", async () => {
		await attachPostalCityIndex(candidatePath)
		using lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		const hits = await lk.findPlace({ text: "Antioch", placetype: "locality", country: "US" })
		expect(hits[0]!.name).toBe("Antioch")
		expect(hits[0]!.lat).toBeCloseTo(38, 1)
	})

	test("a postcode NOT in the side-index falls through to the normal probe", async () => {
		await attachPostalCityIndex(candidatePath)
		using lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		const hits = await lk.findPlace({ text: "Antioch", placetype: "locality", postcode: "99999", country: "US" })
		expect(hits[0]!.name).toBe("Antioch")
	})

	test("a NON-locality request (region) does not consult the locality side-index", async () => {
		await attachPostalCityIndex(candidatePath)
		using lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		const hits = await lk.findPlace({ text: "Antioch", placetype: "region", postcode: "37013", country: "US" })
		expect(hits.every((h) => h.name !== "Nashville")).toBe(true)
	})

	test("A candidate.db WITHOUT the side-index is byte-stable (no probe without throwing)", async () => {
		using lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		const hits = await lk.findPlace({ text: "Antioch", placetype: "locality", postcode: "37013", country: "US" })
		expect(hits[0]!.name).toBe("Antioch")
	})
})
