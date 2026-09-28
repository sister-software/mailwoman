import { WOFSQLitePlaceLookup } from "@mailwoman/resolver-wof-sqlite/lookup"
import {
	WOFPostalCityAliasLookup,
	createPostalCityAliasTable,
	type PostalCityAliasDatabase,
} from "@mailwoman/resolver-wof-sqlite/postal"
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Integration tests for the postal-city alias reader and the coordinate-first scorer wiring.
 */
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

/**
 * A `postal_city_alias` fixture using the production DDL, holding one divergent row and one
 * non-divergent row.
 */
async function buildAliasDB(): Promise<DatabaseClient<PostalCityAliasDatabase>> {
	const kdb = DatabaseClient.temp<PostalCityAliasDatabase>()
	// The caller owns this handle and destroys it after the test. This function does not.

	await createPostalCityAliasTable(kdb)

	const ins = kdb.prepare(
		"INSERT INTO postal_city_alias (postcode, postal_city, geo_locality, n, divergent, source, release) VALUES (?,?,?,?,?,?,?)"
	)

	// The alias signal: 37013 is filed as "Antioch" but geographically sits in Nashville.
	ins.run("37013", "Antioch", "Nashville", 47_389, 1, "overture:US", "2026-04")
	ins.run("22191", "Woodbridge", "Prince William County", 30_975, 1, "overture:US", "2026-04")
	// A row whose postal and geographic names are equal must never surface as an alias.
	ins.run("90210", "Beverly Hills", "Beverly Hills", 12_000, 0, "overture:US", "2026-04")

	return kdb
}

/**
 * Main resolver fixture: Nashville, the geographic city 37013 sits in, and a far Antioch distractor.
 */
function buildMainDB(): DatabaseClient<WOFDatabase> {
	const db = DatabaseClient.temp<WOFDatabase>()

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

	spr.run(1, 0, "Nashville", "locality", "US", 36.16, -86.78, 36, 36.4, -87, -86.5)
	// Antioch, CA: a same-named distractor about 3000 km away the bare name-match would otherwise win.
	spr.run(2, 0, "Antioch", "locality", "US", 38, -121.8, 37.9, 38.1, -121.9, -121.7)
	db.prepare(`INSERT INTO place_population (id, population) VALUES (?, ?)`).run(1, 700_000)
	// 37013's centroid sits in Nashville as the containing locality, and the parsed name "Antioch" does not match it.
	db.prepare(`INSERT INTO postcode_locality VALUES (?,?,?,?,?,?,?)`).run("37013", "US", 1, "Nashville", "", 0, 1)

	return db
}

describe("WOFPostalCityAliasLookup (#475 reader)", () => {
	let reader: WOFPostalCityAliasLookup

	beforeEach(async () => {
		reader = new WOFPostalCityAliasLookup({ database: await buildAliasDB() })
	})

	afterEach(() => reader[Symbol.dispose]())

	it("returns the divergent alias for a known postcode", async () => {
		const aliases = await reader.getDivergentAliases("37013")
		expect(aliases).toHaveLength(1)
		expect(aliases[0]).toMatchObject({ postalCity: "Antioch", geoLocality: "Nashville", n: 47_389 })
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
	let aliasDB: DatabaseClient<PostalCityAliasDatabase>
	afterEach(() => aliasDB?.destroy())

	it("WITHOUT the reader, a postal-city query resolves to the same-named distractor (the bug)", async () => {
		using lookup = new WOFSQLitePlaceLookup({ database: buildMainDB(), buildFTS: true })
		const r = await lookup.findPlace({ text: "Antioch", placetype: "locality", postcode: "37013", country: "US" })
		expect(r[0]?.name).toBe("Antioch")
		expect(r[0]?.mismatch).toBe(true)
	})

	it("WITH the reader, the postal city resolves to its geographic locality (the fix)", async () => {
		aliasDB = await buildAliasDB()

		using lookup = new WOFSQLitePlaceLookup({
			database: buildMainDB(),
			buildFTS: true,
			postalCityAliases: new WOFPostalCityAliasLookup({ database: aliasDB }),
		})

		const r = await lookup.findPlace({ text: "Antioch", placetype: "locality", postcode: "37013", country: "US" })
		expect(r[0]?.name).toBe("Nashville")
		expect(r[0]?.mismatch).toBeFalsy()
	})

	it("an unrelated postcode (no alias) is byte-stable with the reader attached", async () => {
		// A postcode with no divergent alias must behave exactly as without the reader.
		aliasDB = await buildAliasDB()

		using lookup = new WOFSQLitePlaceLookup({
			database: buildMainDB(),
			buildFTS: true,
			postalCityAliases: new WOFPostalCityAliasLookup({ database: aliasDB }),
		})

		const r = await lookup.findPlace({ text: "Antioch", placetype: "locality", postcode: "99999", country: "US" })
		expect(r[0]?.name).toBe("Antioch")
	})
})
