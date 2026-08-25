/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fixtures are built by the PRODUCTION schema builders and populated with rows copied off the shipped artifacts, so
 *   what these tests pin is the real behaviour rather than a restatement of the probe. Two cases exist only because
 *   driving the real artifacts falsified the first implementation: `1012 LG` (route order) and the deprecated-only WOF
 *   name (the FTS index cannot show one, so a second route has to).
 */

import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { openSealedArtifact, type LookupRow } from "@mailwoman/dev-mcp/lookup"
import {
	diffCandidateRows,
	lookupCandidate,
	lookupCodex,
	lookupPOI,
	lookupPostcodeAnchor,
	lookupWOF,
} from "@mailwoman/dev-mcp/lookup-sources"
import {
	createCandidateTable,
	type CandidateDatabase,
	type CandidateTable,
} from "@mailwoman/resolver-wof-sqlite/candidate-schema"
import { buildPlaceSearchFTS } from "@mailwoman/resolver-wof-sqlite/fts"
import {
	createPOINameKeyIndex,
	createPOISearchFTS,
	createPOITable,
	type POIDatabase,
} from "@mailwoman/resolver-wof-sqlite/poi-schema"
import { normalizeLocalityForKey as nameKey } from "@mailwoman/resolver-wof-sqlite/street-normalize"
import { createUnifiedSchema } from "@mailwoman/resolver-wof-sqlite/unified-schema"
import { afterAll, describe, expect, it } from "vitest"

const openHandles: DatabaseSync[] = []

afterAll(() => {
	for (const db of openHandles) {
		db.close()
	}
})

function memoryDatabase(): DatabaseSync {
	const db = new DatabaseSync(":memory:")

	openHandles.push(db)

	return db
}

/**
 * Rows measured against the shipped `candidate.db` on 2026-08-16 — the operator's three false absences plus the NL PC6
 * pair whose stem hides the unit code.
 */
const CANDIDATE_ROWS: Array<Partial<CandidateTable> & Pick<CandidateTable, "name_key" | "spr_id">> = [
	// Each key is minted from the SURFACE the build folds, never written folded by hand — for an alias row that
	// surface is the ALIAS, not the display `name`, which is why "Balearic Islands" keys under `illes balears`.
	{ name_key: nameKey("Porto Petro"), name: "Porto Petro", placetype_id: 1, country_id: 1, spr_id: 1, population: 0 },
	{
		name_key: nameKey("Illes Balears"),
		name: "Balearic Islands",
		placetype_id: 2,
		country_id: 1,
		spr_id: 2,
		is_primary: 0,
	},
	{
		name_key: nameKey("Hart"),
		name: "Hart",
		placetype_id: 1,
		country_id: 2,
		spr_id: 4,
		is_primary: 1,
		importance: 0.55,
	},
	{
		name_key: nameKey("Hart"),
		name: "Hyattsville",
		placetype_id: 1,
		country_id: 2,
		spr_id: 5,
		is_primary: 0,
		importance: 0.31,
	},
	{ name_key: nameKey("1012"), name: "1012", placetype_id: 3, country_id: 3, spr_id: 6, is_primary: 1 },
	{ name_key: nameKey("1012LG"), name: "1012LG", placetype_id: 3, country_id: 3, spr_id: 7, is_primary: 1 },
	{
		name_key: nameKey("Vaduz"),
		name: "Vaduz",
		placetype_id: 1,
		country_id: 4,
		spr_id: 8,
		importance: 0.18,
		population: 5197,
	},
]

async function candidateFixture(): Promise<DatabaseSync> {
	const db = memoryDatabase()
	const kdb = new DatabaseClient<CandidateDatabase>({ database: db })

	await kdb.schema
		.createTable("country_codes")
		.addColumn("id", "integer", (c) => c.primaryKey())
		.addColumn("code", "text")
		.execute()

	await kdb.schema
		.createTable("placetype_codes")
		.addColumn("id", "integer", (c) => c.primaryKey())
		.addColumn("placetype", "text")
		.execute()

	await createCandidateTable(kdb)

	for (const [id, code] of [
		[1, "ES"],
		[2, "US"],
		[3, "NL"],
		[4, "LI"],
	] as const) {
		db.prepare("INSERT INTO country_codes (id, code) VALUES (?, ?)").run(id, code)
	}

	for (const [id, placetype] of [
		[1, "locality"],
		[2, "macroregion"],
		[3, "postalcode"],
	] as const) {
		db.prepare("INSERT INTO placetype_codes (id, placetype) VALUES (?, ?)").run(id, placetype)
	}

	const insert = db.prepare(
		"INSERT INTO candidate (name_key, country_id, region_id, placetype_id, neg_rank, spr_id, name, latitude, " +
			"longitude, population, is_primary, importance) VALUES (?, ?, 0, ?, ?, ?, ?, 0, 0, ?, ?, ?)"
	)

	for (const [index, row] of CANDIDATE_ROWS.entries()) {
		insert.run(
			row.name_key,
			row.country_id ?? 1,
			row.placetype_id ?? 1,
			index,
			row.spr_id,
			row.name ?? null,
			row.population ?? 0,
			row.is_primary ?? 1,
			// `importance` stays NULL unless the fixture row gives one — the UNMEASURED case is the point.
			row.importance ?? null
		)
	}

	return db
}

function rowFor(rows: LookupRow[], query: string): LookupRow {
	const row = rows.find((candidate) => candidate.query === query)

	if (!row) throw new Error(`no row for ${query}`)

	return row
}

describe("lookupCandidate", () => {
	it("finds the three places an exact `name` probe reports as absent", async () => {
		// The trap this source exists to prevent: `name_key` is the fold, so `WHERE name = 'Porto Petro'` on a
		// build that stores `porto petro` answers zero rows and reads as a gazetteer gap.
		const db = await candidateFixture()
		const rows = lookupCandidate(db, ["Porto Petro", "Illes Balears"])

		expect(rowFor(rows, "Porto Petro")).toMatchObject({ hit: true })
		expect(rowFor(rows, "Porto Petro").entries).toMatchObject([{ name_key: "porto petro", route: "exact" }])
		expect(rowFor(rows, "Porto Petro").note).toContain('Probed as name_key "porto petro"')
	})

	it("reports the STORED name when it differs from the surface, and flags the alias row", async () => {
		const db = await candidateFixture()
		const [row] = lookupCandidate(db, ["Illes Balears"])

		expect(row!.entries).toMatchObject([{ name: "Balearic Islands", is_primary: 0 }])
		expect(row!.note).toContain('stored name is "Balearic Islands"')
		expect(row!.note).toContain("is_primary=0")
	})

	it("keeps a NULL importance null and calls it unmeasured, never a zero", async () => {
		const db = await candidateFixture()
		const [row] = lookupCandidate(db, ["Porto Petro"])

		expect((row!.entries![0] as { importance: number | null }).importance).toBeNull()
		expect((row!.entries![0] as { population: number }).population).toBe(0)
		expect(row!.note).toContain("UNMEASURED, never an importance of zero")
	})

	it("reports a real miss as absence and names the tier it did NOT run", async () => {
		const db = await candidateFixture()
		const [row] = lookupCandidate(db, ["Sultan Qaboos"])

		expect(row).toMatchObject({ hit: false, entries: null })
		expect(row!.note).toContain("ABSENCE, not a zero")
		expect(row!.note).toContain("typo corrector")
	})

	it("tries the whitespace fold BEFORE the qualifier strip", async () => {
		// Measured against the shipped candidate.db: strip-first sends `1012 LG` to `1012`, resolving the NL PC6
		// unit to its 4-digit stem (and to a DK row) while the unit's own record sits under `1012lg`. The runtime
		// folds whitespace at the top of findPlace, so this order is the runtime's, not a preference.
		const db = await candidateFixture()
		const [row] = lookupCandidate(db, ["1012 LG"])

		expect(row!.entries).toMatchObject([{ route: "postcode-fold", name_key: "1012lg", name: "1012LG" }])
	})

	it("restricts the qualifier-strip retry to primary rows, as the runtime does", async () => {
		// #1626: an alias-keyed stripped hit is a scrape. `hart` carries a primary Hart and an alias row for
		// Hyattsville; only the first may answer a stripped probe.
		const db = await candidateFixture()
		const [row] = lookupCandidate(db, ["Hart b.Graz"])

		expect(row!.entries).toMatchObject([{ route: "qualifier-strip", name: "Hart", is_primary: 1 }])
		expect(row!.entries).toHaveLength(1)
	})

	it("calls an uncarried country a coverage gap rather than a miss on the name", async () => {
		const db = await candidateFixture()
		const [row] = lookupCandidate(db, ["Vaduz"], { country: "ZZ" })

		expect(row).toMatchObject({ hit: false, entries: null })
		expect(row!.note).toContain("COVERAGE gap")
		expect(row!.note).toContain("4 countries")
	})

	it("distinguishes a filter miss from an absence", async () => {
		const db = await candidateFixture()
		const [row] = lookupCandidate(db, ["Vaduz"], { country: "US" })

		expect(row!.note).toContain("FILTER miss")
		expect(row!.hit).toBe(false)
	})
})

/**
 * Rows measured against the shipped `admin-global-priority.db`: one live place, and the GB name whose thirteen records
 * are every one deprecated.
 */
async function wofFixture(): Promise<DatabaseSync> {
	const db = memoryDatabase()

	await createUnifiedSchema(db)

	const insertSPR = db.prepare(
		"INSERT INTO spr (id, name, placetype, country, latitude, longitude, is_current, is_deprecated) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
	)

	const insertName = db.prepare("INSERT INTO names (id, name, placetype, country, language) VALUES (?, ?, ?, ?, 'eng')")

	insertSPR.run(1, "Porto Petro", "locality", "ES", 39.36169, 3.21005, 1, 0)
	insertName.run(1, "Porto Petro", "locality", "ES")
	insertSPR.run(2, "Birmingham/Wolverhampton/Walsall/Dudley", "locality", "GB", 52.484137, -2.108128, 0, 1)
	insertName.run(2, "Birmingham/Wolverhampton/Walsall/Dudley", "locality", "GB")

	buildPlaceSearchFTS(db)

	return db
}

describe("lookupWOF", () => {
	it("reaches a live record through the FTS index the resolver reads", async () => {
		const db = await wofFixture()
		const [row] = lookupWOF([{ name: "admin.db", db }], ["Porto Petro"])

		expect(row).toMatchObject({ hit: true })
		expect(row!.entries).toMatchObject([{ route: "fts", name: "Porto Petro", shard: "admin.db" }])
	})

	it("reports a deprecated-only name as the THIRD state, not as absence", async () => {
		// The FTS content is built with `is_current != 0 AND is_deprecated = 0` applied, so the resolver's index
		// cannot hold this record at all — the `names` route is the only cheap way to see that it exists.
		const db = await wofFixture()
		const [row] = lookupWOF([{ name: "admin.db", db }], ["Birmingham/Wolverhampton/Walsall/Dudley"])

		expect(row).toMatchObject({ hit: true })
		expect(row!.entries).toEqual([])
		expect(row!.note).toContain("EVERY one is deprecated or not current")
		expect(row!.note).toContain("different from absence")
	})

	it("says what it checked when both routes miss", async () => {
		const db = await wofFixture()
		const [row] = lookupWOF([{ name: "admin.db", db }], ["Zzzznotaplace"])

		expect(row).toMatchObject({ hit: false, entries: null })
		expect(row!.note).toContain("ABSENCE")
		expect(row!.note).toContain("case- and punctuation-sensitive")
	})

	it("names a shard it could not query instead of counting it as a miss", async () => {
		const broken = memoryDatabase()
		const [row] = lookupWOF([{ name: "broken.db", db: broken }], ["Vaduz"])

		expect(row!.note).toContain("probe(s) failed")
		expect(row!.note).toContain("broken.db")
	})
})

async function poiFixture(): Promise<DatabaseSync> {
	const db = memoryDatabase()
	const kdb = new DatabaseClient<POIDatabase>({ database: db })

	await kdb.schema
		.createTable("poi_category_codes")
		.addColumn("id", "integer", (c) => c.primaryKey())
		.addColumn("category", "text")
		.execute()

	await createPOITable(kdb)
	await createPOINameKeyIndex(kdb)
	createPOISearchFTS(db)

	db.prepare("INSERT INTO poi_category_codes (id, category) VALUES (1, 'monument')").run()

	const insert = db.prepare(
		"INSERT INTO poi (h3_cell, category_id, neg_rank, rowid_key, name, name_key, latitude, longitude, country, " +
			"confidence) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)"
	)

	insert.run(1, 0.1, 1, "Eiffel tower", "eiffel tower", 48.87296739, 2.29785971, "FR", 0.915)
	insert.run(2, 0.2, 2, "Eiffel Tower", "eiffel tower", 39.3432881, -84.2669445, "US", 0.876)

	return db
}

describe("lookupPOI", () => {
	it("keys on name_key and reports the count as the denominator", async () => {
		const db = await poiFixture()
		const [row] = lookupPOI(db, ["Eiffel Tower"], { limit: 1 })

		expect(row).toMatchObject({ hit: true })
		expect(row!.entries).toHaveLength(1)
		expect(row!.note).toContain('2 POI row(s) under key "eiffel tower"')
	})

	it("reports a country that filters everything out as a filter miss", async () => {
		const db = await poiFixture()
		const [row] = lookupPOI(db, ["Eiffel Tower"], { country: "DE" })

		expect(row).toMatchObject({ hit: true })
		expect(row!.entries).toEqual([])
		expect(row!.note).toContain("filter miss")
	})

	it("reports a genuine miss as absence and scopes the claim to the exact-key path", async () => {
		const db = await poiFixture()
		const [row] = lookupPOI(db, ["Sultan Qaboos Grand Mosque"])

		expect(row).toMatchObject({ hit: false, entries: null })
		expect(row!.note).toContain("ABSENCE")
		expect(row!.note).toContain("exact-key path only")
	})
})

describe("lookupCodex", () => {
	it("answers the shape question and says it is not a membership question", () => {
		const [row] = lookupCodex(["68161"])

		expect(row!.entries).toMatchObject([{ table: "postcode_systems", systems: ["us", "de", "fr"] }])
		expect(row!.note).toContain("SHAPE test, not gazetteer membership")
	})

	it("reaches the USPS tables a street parse turns on", () => {
		const rows = lookupCodex(["Blvd", "APT", "NW", "CA"])

		expect(rowFor(rows, "Blvd").entries).toMatchObject([{ table: "us_street_suffix", suffix: "BOULEVARD" }])
		expect(rowFor(rows, "APT").entries).toMatchObject([{ table: "us_unit_designator", designator: "APARTMENT" }])
		expect(rowFor(rows, "NW").entries).toMatchObject([{ table: "us_directional", directional: "NORTH WEST" }])
		expect(rowFor(rows, "CA").entries).toMatchObject([{ table: "us_state", name: "California" }])
	})

	it("reports an unknown string as absence from the reference data only", () => {
		const [row] = lookupCodex(["Zzzz"])

		expect(row).toMatchObject({ hit: false, entries: null })
		expect(row!.note).toContain("says nothing about any gazetteer")
	})
})

describe("lookupPostcodeAnchor", () => {
	/**
	 * Centroids measured off the shipped binaries and rounded: `10118` carries one, `01477` is one of the 414 keys in
	 * `postcode-us.bin` that carry none, and `SW1A2AA` is a GB key the US bundle does not hold.
	 */
	const resolver = {
		lookup: (postcode: string) =>
			postcode === "10118"
				? [{ country: "US", lat: 40.7495, lon: -73.9842 }]
				: postcode === "01477"
					? [{ country: "US", lat: 0, lon: 0 }]
					: postcode === "SW1A2AA"
						? [{ country: "GB", lat: 51.5027, lon: -0.1263 }]
						: [],
	}

	it("reports a membership-only record as a MEASURED ZERO", () => {
		const [row] = lookupPostcodeAnchor(resolver, ["01477"], { spanMode: "shaped" })

		expect(row).toMatchObject({ hit: true })
		expect(row!.entries).toMatchObject([{ country: "US", has_centroid: false }])
		expect(row!.note).toContain("MEMBERSHIP ONLY")
		expect(row!.note).toContain("measured zero, not a missing entry")
	})

	it("keys a spaced code the way the train painter does", () => {
		const [row] = lookupPostcodeAnchor(resolver, ["SW1A 2AA"], { spanMode: "shaped" })

		expect(row).toMatchObject({ hit: true })
		expect(row!.note).toContain('Keyed as "SW1A2AA"')
	})

	it("says a present record is unreachable at serve under an alnum-run card", () => {
		// The artifact HAS the key and the running model is never fed it — a hit and a warning, not a miss.
		const [row] = lookupPostcodeAnchor(resolver, ["SW1A 2AA"], { spanMode: "alnum-run" })

		expect(row!.hit).toBe(true)
		expect(row!.note).toContain("can NEVER produce this key")
	})

	it("scopes an absence to the loaded bundle", () => {
		const [row] = lookupPostcodeAnchor(resolver, ["99999"], { spanMode: "shaped" })

		expect(row).toMatchObject({ hit: false, entries: null })
		expect(row!.note).toContain("a claim about one weights package")
	})
})

describe("openSealedArtifact", () => {
	it("reports a missing file by path rather than as an empty source", () => {
		const opened = openSealedArtifact("/nonexistent/candidate.db")

		expect("unavailable" in opened && opened.unavailable).toContain("/nonexistent/candidate.db")
	})

	it("reports an unresolved path distinctly from a missing one", () => {
		expect(openSealedArtifact(undefined)).toEqual({
			unavailable: "No artifact path was resolved for this source.",
		})
	})
})

describe("lookupCandidate fame-diagnosis extras", () => {
	it("carries name_role on artifacts that stamp it, null on unstamped rows", async () => {
		const db = await candidateFixture()

		db.prepare("UPDATE candidate SET name_role = 'variant' WHERE spr_id = ?").run(1)

		const [row] = lookupCandidate(db, ["Porto Petro"])
		const entries = (row!.entries ?? []) as Array<{ spr_id: number; name_role?: string | null }>

		expect(entries.length).toBeGreaterThan(0)

		for (const entry of entries) {
			expect(entry.name_role).toBe(entry.spr_id === 1 ? "variant" : null)
		}
	})

	it("joins importance_split by spr_id when an importance DB is given, and reports a missing row as null", async () => {
		const db = await candidateFixture()
		const importance = new DatabaseSync(":memory:")

		importance.exec(
			"CREATE TABLE place_importance (id INTEGER PRIMARY KEY, referential REAL NOT NULL, encyclopedic REAL, importance REAL NOT NULL)"
		)

		importance
			.prepare("INSERT INTO place_importance (id, referential, encyclopedic, importance) VALUES (?, ?, ?, ?)")
			.run(1, 0.2921, 0.3375, 0.3375)

		const [row] = lookupCandidate(db, ["Porto Petro"], { importance: { db: importance, artifact: "importance.db" } })

		const entries = (row!.entries ?? []) as Array<{
			spr_id: number
			importance_split?: { referential: number; encyclopedic: number | null } | null
		}>

		for (const entry of entries) {
			if (entry.spr_id === 1) {
				expect(entry.importance_split).toEqual({ referential: 0.2921, encyclopedic: 0.3375 })
			} else {
				// The source holds no row for this place: null, never a fabricated zero.
				expect(entry.importance_split).toBeNull()
			}
		}

		// Without the option the property is ABSENT — unread, not measured-empty.
		const [bare] = lookupCandidate(db, ["Porto Petro"])
		const bareEntries = (bare!.entries ?? []) as Array<{ importance_split?: unknown }>

		expect(bareEntries.every((entry) => !("importance_split" in entry))).toBe(true)

		importance.close()
	})

	it("diffs two artifacts' returned rows: presence both ways plus moved ranking fields", async () => {
		const dbA = await candidateFixture()
		const dbB = await candidateFixture()

		// B re-scores one shared row and holds one extra bearer under the same key.
		dbB.prepare("UPDATE candidate SET importance = 0.5 WHERE spr_id = ?").run(1)

		dbB
			.prepare(
				"INSERT INTO candidate (name_key, country_id, region_id, placetype_id, neg_rank, spr_id, name, latitude, " +
					"longitude, population, is_primary, importance) VALUES (?, 2, 0, 1, 99, 999, ?, 0, 0, 5, 1, NULL)"
			)
			.run(nameKey("Porto Petro"), "Porto Petro")

		const rowsA = lookupCandidate(dbA, ["Porto Petro"])
		const rowsB = lookupCandidate(dbB, ["Porto Petro"])
		const [delta] = diffCandidateRows(rowsA, rowsB)

		expect(delta!.only_in_a).toEqual([])
		expect(delta!.only_in_b.map((entry) => entry.spr_id)).toEqual([999])

		const moved = delta!.changed.find((entry) => entry.spr_id === 1)

		expect(moved!.fields["importance"]).toEqual([null, 0.5])
	})
})
