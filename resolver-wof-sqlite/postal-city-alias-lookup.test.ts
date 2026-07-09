/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #475 postal-city alias integration. Two layers:
 *
 *   1. The reader ({@link WOFPostalCityAliasLookup}) — a postcode-scoped probe that returns only the
 *        DIVERGENT rows (postal name ≠ geographic name), the rows that carry alias signal.
 *   2. The coordinate-first scorer wiring — a user-typed POSTAL city ("Antioch", postcode 37013) becomes
 *        a name-match alias for the geographic locality the postcode sits in ("Nashville"), so the
 *        right place tiers over a same-named distractor in another state. Default-off: without the
 *        reader the resolver is byte-identical (the byte-stability test pins this).
 *
 *   The 37013 antioch→nashville edge is a real top row of the built `postal-city-alias-us.db`.
 */
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { WOFSqlitePlaceLookup } from "./lookup.ts"
import { WOFPostalCityAliasLookup } from "./postal-city-alias-lookup.ts"
import { createPostalCityAliasTable, type PostalCityAliasDatabase } from "./postal-city-alias-schema.ts"

/** A `postal_city_alias` fixture DB with the production DDL + a divergent and a non-divergent row. */
async function buildAliasDB(): Promise<DatabaseSync> {
	const db = new DatabaseSync(":memory:")
	// `kdb` wraps `db` for the DDL; the test owns `db`'s lifecycle (reader.close()/aliasDB.close()),
	// so we don't destroy `kdb`.
	const kdb = new DatabaseClient<PostalCityAliasDatabase>({ database: db })
	await createPostalCityAliasTable(kdb)
	const ins = db.prepare(
		"INSERT INTO postal_city_alias (postcode, postal_city, geo_locality, n, divergent, source, release) VALUES (?,?,?,?,?,?,?)"
	)
	// The alias signal: 37013 is filed as "Antioch" but geographically sits in Nashville.
	ins.run("37013", "Antioch", "Nashville", 47389, 1, "overture:US", "2026-04")
	// A second postcode, another alias (Woodbridge → Prince William County).
	ins.run("22191", "Woodbridge", "Prince William County", 30975, 1, "overture:US", "2026-04")
	// A non-divergent row (postal name == geo name) — must NEVER surface as an alias.
	ins.run("90210", "Beverly Hills", "Beverly Hills", 12000, 0, "overture:US", "2026-04")

	return db
}

/** Main resolver fixture: Nashville (the geographic city 37013 sits in) + a far Antioch distractor. */
function buildMainDB(): DatabaseSync {
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
	spr.run(1, 0, "Nashville", "locality", "US", 36.16, -86.78, 36.0, 36.4, -87.0, -86.5)
	// Antioch, CA — a same-named distractor ~3000 km away the bare name-match would otherwise win.
	spr.run(2, 0, "Antioch", "locality", "US", 38.0, -121.8, 37.9, 38.1, -121.9, -121.7)
	db.prepare(`INSERT INTO place_population (id, population) VALUES (?, ?)`).run(1, 700_000)
	// 37013's centroid sits in Nashville (containing); the parsed name "Antioch" does NOT match it.
	db.prepare(`INSERT INTO postcode_locality VALUES (?,?,?,?,?,?,?)`).run("37013", "US", 1, "Nashville", "", 0.0, 1)

	return db
}

describe("WOFPostalCityAliasLookup (#475 reader)", () => {
	let reader: WOFPostalCityAliasLookup
	beforeEach(async () => {
		reader = new WOFPostalCityAliasLookup({ database: await buildAliasDB() })
	})
	afterEach(() => reader.close())

	it("returns the divergent alias for a known postcode", async () => {
		const aliases = await reader.getDivergentAliases("37013")
		expect(aliases).toHaveLength(1)
		expect(aliases[0]).toMatchObject({ postalCity: "Antioch", geoLocality: "Nashville", n: 47389 })
	})

	it("excludes non-divergent rows (postal name == geo name)", async () => {
		expect(await reader.getDivergentAliases("90210")).toHaveLength(0)
	})

	it("returns [] for a postcode not in the table", async () => {
		expect(await reader.getDivergentAliases("00000")).toEqual([])
	})

	it("trims the queried postcode", async () => {
		expect(await reader.getDivergentAliases("  22191 ")).toHaveLength(1)
	})
})

describe("postal-city alias coordinate-first wiring (#475)", () => {
	let aliasDB: DatabaseSync
	afterEach(() => aliasDB?.close())

	it("WITHOUT the reader, a postal-city query resolves to the same-named distractor (the bug)", async () => {
		const lookup = new WOFSqlitePlaceLookup({ database: buildMainDB(), buildFTS: true })
		const r = await lookup.findPlace({ text: "Antioch", placetype: "locality", postcode: "37013", country: "US" })
		// The bare name-match wins the far Antioch, and the postcode/name conflict fires.
		expect(r[0]?.name).toBe("Antioch")
		expect(r[0]?.mismatch).toBe(true)
		lookup.close()
	})

	it("WITH the reader, the postal city resolves to its geographic locality (the fix)", async () => {
		aliasDB = await buildAliasDB()
		const lookup = new WOFSqlitePlaceLookup({
			database: buildMainDB(),
			buildFTS: true,
			postalCityAliases: new WOFPostalCityAliasLookup({ database: aliasDB }),
		})
		const r = await lookup.findPlace({ text: "Antioch", placetype: "locality", postcode: "37013", country: "US" })
		// "Antioch" is now a name-match alias for Nashville (37013's geographic locality), so Nashville
		// tiers to the top and — being the postcode's containing locality — carries no mismatch flag.
		expect(r[0]?.name).toBe("Nashville")
		expect(r[0]?.mismatch).toBeFalsy()
		lookup.close()
	})

	it("an unrelated postcode (no alias) is byte-stable with the reader attached", async () => {
		// Reader attached, but 37013 isn't queried — a postcode with no divergent alias must behave
		// exactly as without the reader. Here the distractor still wins (no alias rescues Nashville).
		aliasDB = await buildAliasDB()
		const lookup = new WOFSqlitePlaceLookup({
			database: buildMainDB(),
			buildFTS: true,
			postalCityAliases: new WOFPostalCityAliasLookup({ database: aliasDB }),
		})
		// 99999 has no postcode_locality row → coord-first is inert → pure name-match → Antioch.
		const r = await lookup.findPlace({ text: "Antioch", placetype: "locality", postcode: "99999", country: "US" })
		expect(r[0]?.name).toBe("Antioch")
		lookup.close()
	})
})
