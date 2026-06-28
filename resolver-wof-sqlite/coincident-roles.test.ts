/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the coincident-roles relation builder (#403, epic #402). Builds an in-memory fixture
 *   gazetteer (spr + ancestors + place_population) covering the city-state, capital-seat, and
 *   too-far (excluded) cases, then asserts the derived relation + the in-memory loader.
 */

import { DatabaseSync } from "node:sqlite"

import { afterEach, beforeEach, describe, expect, test } from "vitest"

import {
	buildCoincidentRoles,
	coincidentRolesExists,
	loadCoincidentRoles,
	type CoincidentRole,
} from "./coincident-roles.js"

interface FixtureRow {
	id: number
	name: string
	placetype: string
	country: string
	lat: number
	lon: number
	/**
	 * Half-extent in degrees → bbox = [lat±d, lon±d]. Bigger d ⇒ bigger bbox ⇒ looser relative tolerance.
	 */
	d: number
	population?: number
}

// Region/locality pairs. A locality is made a DESCENDANT of a region via the `ancestors` table below.
const FIXTURE: FixtureRow[] = [
	// Berlin — city-state: region + locality centroids coincide (dist 0), small bbox.
	{ id: 10, name: "Berlin", placetype: "region", country: "DE", lat: 52.52, lon: 13.4, d: 0.3 },
	{
		id: 11,
		name: "Berlin",
		placetype: "locality",
		country: "DE",
		lat: 52.52,
		lon: 13.4,
		d: 0.2,
		population: 3_600_000,
	},
	// Milano — capital-seat: large province bbox, comune ~5 km from the province centroid.
	{ id: 20, name: "Milano", placetype: "region", country: "IT", lat: 45.5, lon: 9.2, d: 0.6 },
	{
		id: 21,
		name: "Milano",
		placetype: "locality",
		country: "IT",
		lat: 45.46,
		lon: 9.19,
		d: 0.2,
		population: 1_350_000,
	},
	// Brandenburg — NOT dual-role: same-name town ~75 km W of the region centroid → beyond the relative
	// tolerance (region bbox ⌀ ~313 km → 15 % ≈ 47 km). Mirrors the real gazetteer, where Brandenburg
	// is correctly absent from the 128.
	{ id: 30, name: "Brandenburg", placetype: "region", country: "DE", lat: 52.4, lon: 13.0, d: 1.2 },
	{
		id: 31,
		name: "Brandenburg",
		placetype: "locality",
		country: "DE",
		lat: 52.41,
		lon: 11.9,
		d: 0.1,
		population: 72_000,
	},
	// Bayern region + München locality (different name) → never matched.
	{ id: 40, name: "Bayern", placetype: "region", country: "DE", lat: 48.9, lon: 11.4, d: 1.5 },
	{
		id: 41,
		name: "München",
		placetype: "locality",
		country: "DE",
		lat: 48.14,
		lon: 11.58,
		d: 0.2,
		population: 1_500_000,
	},
	// County-tier same-name pair (a French-canton analogue) → excluded (v1 is region-tier only).
	{ id: 50, name: "Casteljaloux", placetype: "county", country: "FR", lat: 44.3, lon: 0.09, d: 0.4 },
	{
		id: 51,
		name: "Casteljaloux",
		placetype: "locality",
		country: "FR",
		lat: 44.3,
		lon: 0.1,
		d: 0.05,
		population: 5000,
	},
	// Ambiguous region: two same-name coincident localities → relation records BOTH (resolver disambiguates).
	{ id: 60, name: "Padova", placetype: "region", country: "IT", lat: 45.4, lon: 11.87, d: 0.5 },
	{ id: 61, name: "Padova", placetype: "locality", country: "IT", lat: 45.41, lon: 11.88, d: 0.1, population: 200_000 },
	{ id: 62, name: "Padova", placetype: "locality", country: "IT", lat: 45.45, lon: 11.95, d: 0.1, population: 20 },
]

// (locality id → its region ancestor id)
const ANCESTRY: Array<[number, number]> = [
	[11, 10],
	[21, 20],
	[31, 30],
	[51, 50],
	[61, 60],
	[62, 60],
]

let db: DatabaseSync

beforeEach(() => {
	db = new DatabaseSync(":memory:")
	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL,
			min_latitude REAL, min_longitude REAL, max_latitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER
		);
		CREATE TABLE ancestors (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT);
		CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER NOT NULL);
	`)
	const insSpr = db.prepare(
		`INSERT INTO spr (id, parent_id, name, placetype, country, latitude, longitude,
			min_latitude, min_longitude, max_latitude, max_longitude, is_current, is_deprecated)
			VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`
	)
	const insPop = db.prepare(`INSERT INTO place_population (id, population) VALUES (?, ?)`)

	for (const r of FIXTURE) {
		insSpr.run(r.id, r.name, r.placetype, r.country, r.lat, r.lon, r.lat - r.d, r.lon - r.d, r.lat + r.d, r.lon + r.d)

		if (r.population !== undefined) insPop.run(r.id, r.population)
	}
	const insAnc = db.prepare(`INSERT INTO ancestors (id, ancestor_id, ancestor_placetype) VALUES (?, ?, 'region')`)

	for (const [id, anc] of ANCESTRY) insAnc.run(id, anc)
})

afterEach(() => db.close())

function rolesFor(adminId: number): CoincidentRole[] {
	return loadCoincidentRoles(db).get(adminId) ?? []
}

describe("buildCoincidentRoles", () => {
	test("records city-state and capital-seat region pairs", () => {
		const result = buildCoincidentRoles(db)
		expect(coincidentRolesExists(db)).toBe(true)

		const berlin = rolesFor(10)
		expect(berlin).toHaveLength(1)
		expect(berlin[0]).toMatchObject({ localityId: 11, relationshipType: "city-state", population: 3_600_000 })

		const milano = rolesFor(20)
		expect(milano).toHaveLength(1)
		expect(milano[0]).toMatchObject({ localityId: 21, relationshipType: "capital-seat" })

		expect(result.byCountry).toMatchObject({ DE: expect.any(Number), IT: expect.any(Number) })
	})

	test("excludes a same-name town beyond the relative tolerance (Brandenburg ~75 km)", () => {
		buildCoincidentRoles(db)
		expect(rolesFor(30)).toHaveLength(0)
	})

	test("excludes county-tier pairs (v1 is region-tier only)", () => {
		buildCoincidentRoles(db)
		expect(rolesFor(50)).toHaveLength(0)
	})

	test("never matches a region to a differently-named locality", () => {
		buildCoincidentRoles(db)
		expect(rolesFor(40)).toHaveLength(0)
	})

	test("records BOTH localities for an ambiguous admin (resolver disambiguates)", () => {
		buildCoincidentRoles(db)
		const padova = rolesFor(60)
		expect(padova).toHaveLength(2)
		expect(padova.map((r) => r.localityId).sort()).toEqual([61, 62])
	})

	test("is idempotent — a rebuild yields the same row count", () => {
		const a = buildCoincidentRoles(db)
		const b = buildCoincidentRoles(db)
		expect(b.rowCount).toBe(a.rowCount)
	})

	test("loadCoincidentRoles returns an empty map when the table is absent", () => {
		const fresh = new DatabaseSync(":memory:")
		expect(loadCoincidentRoles(fresh).size).toBe(0)
		expect(coincidentRolesExists(fresh)).toBe(false)
		fresh.close()
	})
})
