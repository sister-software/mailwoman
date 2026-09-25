import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile, writeLocalFile } from "@mailwoman/core/fs/writers"
import { GEONAMES_ID_BASE } from "@mailwoman/core/resolver/synthetic-id-ranges"
import { ingestGeonamesAliases } from "@mailwoman/resolver-wof-sqlite/geonames"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterAll, beforeAll, expect, test } from "vitest"

type Row = Record<string, string | number | null>

let dir: TemporaryDirectory

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
		dir.path("BW.txt")
	)

	await writeLocalTextFile(
		[
			row({ 0: "2761369", 1: "Wien", 2: "Wien", 3: "Vienna", 4: "48.2", 5: "16.37", 6: "P", 7: "PPLC", 8: "AT" }),
			row({ 0: "2761370", 1: "Aichegg", 2: "Aichegg", 4: "47.05", 5: "15.2", 6: "P", 7: "PPL", 8: "AT" }),
		].join("\n"),
		dir.path("AT.txt")
	)
})

afterAll(() => dir[Symbol.asyncDispose]())

test("a re-fold with a different country list leaves no name bound to another country's place", async () => {
	using db = freshDB()

	await ingestGeonamesAliases(db, ["BW", "AT"], dir.path, () => {})

	expect((db.prepare(`SELECT name, country FROM spr WHERE id = ?`).get(GEONAMES_ID_BASE) as Row).name).toBe("Gaborone")

	await ingestGeonamesAliases(db, ["AT"], dir.path, () => {})

	const disagreeing = db
		.prepare(`SELECT COUNT(*) AS n FROM names n JOIN spr s ON s.id = n.id WHERE n.id >= ? AND n.country <> s.country`)
		.get(GEONAMES_ID_BASE) as Row

	expect(disagreeing.n).toBe(0)
})

test("a re-fold rewrites the range wholesale — no row survives from the previous run", async () => {
	using db = freshDB()

	await ingestGeonamesAliases(db, ["BW", "AT"], dir.path, () => {})
	await ingestGeonamesAliases(db, ["AT"], dir.path, () => {})

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
	using db = freshDB()

	await ingestGeonamesAliases(db, ["BW", "AT"], dir.path, () => {})

	expect(
		(db.prepare(`SELECT population FROM place_population WHERE id = ?`).get(GEONAMES_ID_BASE) as Row)?.population
	).toBe(208_411)

	await ingestGeonamesAliases(db, ["AT"], dir.path, () => {})

	const pop = db.prepare(`SELECT population FROM place_population WHERE id = ?`).get(GEONAMES_ID_BASE) as
		| Row
		| undefined

	expect(pop).toBeUndefined()
})

test("re-folding the SAME list twice is a no-op, not a doubling", async () => {
	using db = freshDB()

	await ingestGeonamesAliases(db, ["BW", "AT"], dir.path, () => {})
	const first = db.prepare(`SELECT COUNT(*) AS n FROM names WHERE id >= ?`).get(GEONAMES_ID_BASE) as Row

	await ingestGeonamesAliases(db, ["BW", "AT"], dir.path, () => {})
	const second = db.prepare(`SELECT COUNT(*) AS n FROM names WHERE id >= ?`).get(GEONAMES_ID_BASE) as Row

	expect(second.n).toBe(first.n)
})

test("every folded locality gets its self-ancestor row, admin fold or not", async () => {
	using db = freshDB()

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
	using db = freshDB()

	db.prepare(`INSERT INTO names (id, name, placetype, country, language, privateuse, official, lastmodified)
	            VALUES (?, 'AD500', 'postalcode', 'AD', '', '', 0, 0)`).run(9_500_000_000_000)

	await ingestGeonamesAliases(db, ["AT"], dir.path, () => {})

	const postal = db.prepare(`SELECT COUNT(*) AS n FROM names WHERE id >= ?`).get(9_500_000_000_000) as Row

	expect(postal.n).toBe(1)
})
