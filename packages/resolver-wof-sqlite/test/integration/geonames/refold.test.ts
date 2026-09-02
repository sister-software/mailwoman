/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #1514 — the alias fold must be IDEMPOTENT against a DB that already carries a fold.
 *
 *   The synthetic id a GeoNames place gets is its POSITION in the run (`GEONAMES_ID_BASE + n`,
 *   counted across the country list in order), not a derivation from its geonameid. So two runs with
 *   different country lists put different places at the same id. That alone is survivable — a fold
 *   output is only ever read as a whole — but the writes were not: `spr`/`place_population` used
 *   `INSERT OR REPLACE` (overwrite the PREFIX the new run reaches, leave the tail), while
 *   `names`/`ancestors` used a bare `INSERT` (append, never clear). Re-folding therefore left the
 *   previous run's NAMES bound to ids whose `spr` row now described a different place.
 *
 *   Live receipt (2026-08-05 18:09, `admin-global-priority-geonames.db`): id 9000000121151 held
 *   Gaborone/BW from the 161-country fold baked into `admin-global-priority.db`; a 14-country re-fold
 *   overwrote it with Aichegg/AT (Styria) and kept all 26 Gaborone name rows. 522,184 of 2,110,096
 *   name rows in the range (24.7 %) ended up on a place from another country; `geocode Gaborone`
 *   returned a Styrian coordinate. `place_population` was worse than either: its write is guarded by
 *   `pop > 0`, so Kinshasa's 16,000,000 stayed attached to a Lithuanian hamlet with no population.
 *
 *   The fixture below is the same shape at three rows: fold A (two countries), then fold B (one
 *   country) over the same DB.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile, writeLocalFile } from "@mailwoman/core/fs/writers"
import { GEONAMES_ID_BASE, ingestGeonamesAliases } from "@mailwoman/resolver-wof-sqlite/geonames"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterAll, beforeAll, expect, test } from "vitest"

type Row = Record<string, string | number | null>

let dir: TemporaryDirectory

/**
 * One GeoNames dump row: 19 tab-separated columns (id, name, ascii, alt, lat, lon, fclass, fcode, country, cc2, admin1,
 * admin2, admin3, admin4, pop, elev, dem, tz, mod).
 */
function row(over: Record<number, string>): string {
	const f = new Array(19).fill("")

	for (const [i, v] of Object.entries(over)) {
		f[Number(i)] = v
	}

	return f.join("\t")
}

function freshDB(): DatabaseClient<WOFDatabase> {
	const db = DatabaseClient.temp<WOFDatabase>()

	db.exec(
		`CREATE TABLE spr (id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
		 latitude REAL, longitude REAL, min_latitude REAL, min_longitude REAL, max_latitude REAL, max_longitude REAL,
		 is_current INTEGER, is_deprecated INTEGER, is_ceased INTEGER, is_superseded INTEGER, is_superseding INTEGER, lastmodified INTEGER)`
	)

	db.exec(
		`CREATE TABLE names (id INTEGER, name TEXT, placetype TEXT, country TEXT, language TEXT, privateuse TEXT, official INTEGER, lastmodified INTEGER)`
	)

	db.exec(`CREATE TABLE ancestors (id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT, lastmodified INTEGER)`)
	db.exec(`CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER)`)

	return db
}

beforeAll(async () => {
	dir = await temporaryDirectory("geonames-refold-")

	// Fold A's set, in list order: BW then AT. BW's single place lands at GEONAMES_ID_BASE + 0.
	await writeLocalFile(
		row({
			0: "933773",
			1: "Gaborone",
			2: "Gaborone",
			3: "Gaberones,Gaborone City",
			4: "-24.65451",
			5: "25.90859",
			6: "P",
			7: "PPLC",
			8: "BW",
			14: "208411",
		}),
		dir.resolve("BW.txt")
	)

	// AT carries two places so a second, shorter run cannot cover the whole range fold A wrote.
	await writeLocalTextFile(
		[
			row({ 0: "2761369", 1: "Wien", 2: "Wien", 3: "Vienna", 4: "48.2", 5: "16.37", 6: "P", 7: "PPLC", 8: "AT" }),
			row({ 0: "2761370", 1: "Aichegg", 2: "Aichegg", 4: "47.05", 5: "15.2", 6: "P", 7: "PPL", 8: "AT" }),
		].join("\n"),
		dir.resolve("AT.txt")
	)
})

afterAll(() => dir[Symbol.asyncDispose]())

test("a re-fold with a different country list leaves no name bound to another country's place", async () => {
	await using db = freshDB()

	// Fold A — the 2-country recipe baked into the admin artifact.
	await ingestGeonamesAliases(db, ["BW", "AT"], dir.path, () => {})

	expect((db.prepare(`SELECT name, country FROM spr WHERE id = ?`).get(GEONAMES_ID_BASE) as Row).name).toBe("Gaborone")

	// Fold B — the shorter list a downstream step defaults to. Its first place takes the id Gaborone held.
	await ingestGeonamesAliases(db, ["AT"], dir.path, () => {})

	const disagreeing = db
		.prepare(`SELECT COUNT(*) AS n FROM names n JOIN spr s ON s.id = n.id WHERE n.id >= ? AND n.country <> s.country`)
		.get(GEONAMES_ID_BASE) as Row

	expect(disagreeing.n).toBe(0)
})

test("a re-fold rewrites the range wholesale — no row survives from the previous run", async () => {
	await using db = freshDB()

	await ingestGeonamesAliases(db, ["BW", "AT"], dir.path, () => {})
	await ingestGeonamesAliases(db, ["AT"], dir.path, () => {})

	// Fold B declared AT only. Nothing from BW may remain — not an spr row, not a name, not a
	// population. A surviving row is a row no run is accountable for.
	const leftovers = db
		.prepare(
			`SELECT (SELECT COUNT(*) FROM spr WHERE id >= ? AND country = 'BW') AS spr,
			        (SELECT COUNT(*) FROM names WHERE id >= ? AND country = 'BW') AS names`
		)
		.get(GEONAMES_ID_BASE, GEONAMES_ID_BASE) as Row

	expect(leftovers).toEqual({ spr: 0, names: 0 })

	const sprRows = db.prepare(`SELECT COUNT(*) AS n FROM spr WHERE id >= ?`).get(GEONAMES_ID_BASE) as Row

	expect(sprRows.n).toBe(2)
})

test("a stale population cannot outlive the place it belonged to", async () => {
	// The `pop > 0` guard on the population write is what made this the worst of the three tables:
	// an unpopulated place inheriting a metropolis's population is not a name error, it is a ranking
	// error, and it moves the wrong row to the top of every candidate list.
	await using db = freshDB()

	await ingestGeonamesAliases(db, ["BW", "AT"], dir.path, () => {})

	expect(
		(db.prepare(`SELECT population FROM place_population WHERE id = ?`).get(GEONAMES_ID_BASE) as Row)?.population
	).toBe(208_411)

	await ingestGeonamesAliases(db, ["AT"], dir.path, () => {})

	// Wien now holds that id and the fixture gives it no population — so there must be no row at all.
	const pop = db.prepare(`SELECT population FROM place_population WHERE id = ?`).get(GEONAMES_ID_BASE) as
		| Row
		| undefined

	expect(pop).toBeUndefined()
})

test("re-folding the SAME list twice is a no-op, not a doubling", async () => {
	await using db = freshDB()

	await ingestGeonamesAliases(db, ["BW", "AT"], dir.path, () => {})
	const first = db.prepare(`SELECT COUNT(*) AS n FROM names WHERE id >= ?`).get(GEONAMES_ID_BASE) as Row

	await ingestGeonamesAliases(db, ["BW", "AT"], dir.path, () => {})
	const second = db.prepare(`SELECT COUNT(*) AS n FROM names WHERE id >= ?`).get(GEONAMES_ID_BASE) as Row

	expect(second.n).toBe(first.n)
})

test("every folded locality gets its self-ancestor row, admin fold or not", async () => {
	// The purge clears `ancestors` in the range too, and the fold-on-copy path never runs the freeze
	// phase's `populateAncestors` closure — so the fold owes the closure's output for its own rows. The
	// self row is the part that used to be conditioned on the #267 admin fold and so went missing for every
	// country that already had WOF/Overture admin.
	await using db = freshDB()

	await ingestGeonamesAliases(db, ["BW", "AT"], dir.path, () => {})

	const selves = db
		.prepare(
			`SELECT COUNT(*) AS n FROM ancestors a JOIN spr s ON s.id = a.id
			 WHERE a.id >= ? AND a.ancestor_id = a.id AND a.ancestor_placetype = 'locality'`
		)
		.get(GEONAMES_ID_BASE) as Row

	const localities = db
		.prepare(`SELECT COUNT(*) AS n FROM spr WHERE id >= ? AND placetype = 'locality'`)
		.get(GEONAMES_ID_BASE) as Row

	expect(selves.n).toBe(localities.n)
	expect(localities.n).toBe(3)
})

test("the purge stops at the GeoNames-POSTAL namespace above it", async () => {
	// The alias fold owns [9e12, 9.5e12). The postal fold, the NL-PC6 extract (9.6e12), Code-Point
	// (9.7e12) and NI (9.8e12) each own their own range — a purge that ran to the end of the id space
	// would silently delete them.
	await using db = freshDB()

	db.prepare(`INSERT INTO names (id, name, placetype, country, language, privateuse, official, lastmodified)
	            VALUES (?, 'AD500', 'postalcode', 'AD', '', '', 0, 0)`).run(9_500_000_000_000)

	await ingestGeonamesAliases(db, ["AT"], dir.path, () => {})

	const postal = db.prepare(`SELECT COUNT(*) AS n FROM names WHERE id >= ?`).get(9_500_000_000_000) as Row

	expect(postal.n).toBe(1)
})
