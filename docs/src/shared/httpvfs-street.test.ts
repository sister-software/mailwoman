/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for the demo's street tier: the httpvfs situs/interp lookups
 *   (HttpvfsAddressPointLookup, HttpvfsInterpolator) against a node:sqlite-backed stub worker that
 *   mimics sql.js-httpvfs's `db.exec` contract ([] on no rows, else [{columns, values}]), plus
 *   `resolveStreet`'s tier ordering with stub lookups. Synthetic in-memory shards — no /mnt/playpen
 *   dependency, CI-safe. Integration against real shards is the `verify-httpvfs-street` probe in
 *   the geocoder-demo spec.
 */

import { DatabaseSync } from "node:sqlite"

import { afterEach, describe, expect, test } from "vitest"

import { resolveStreet } from "./demo-helpers.js"
import { HttpvfsAddressPointLookup, HttpvfsInterpolator } from "./httpvfs-street.js"

/** Wrap a node:sqlite DB as the minimal httpvfs worker handle (async exec, sql.js result shape). */
function stubWorker(db: DatabaseSync) {
	return {
		db: {
			async exec(sql: string) {
				const rows = db.prepare(sql).all() as Record<string, unknown>[]

				if (rows.length === 0) return []
				const columns = Object.keys(rows[0]!)

				return [{ columns, values: rows.map((r) => columns.map((c) => r[c])) }]
			},
		},
	}
}

const openDbs: DatabaseSync[] = []
function db(setup: (d: DatabaseSync) => void): DatabaseSync {
	const d = new DatabaseSync(":memory:")
	setup(d)
	openDbs.push(d)

	return d
}
afterEach(() => {
	while (openDbs.length) openDbs.pop()!.close()
})

function situsDb(): DatabaseSync {
	return db((d) => {
		d.exec(
			"CREATE TABLE address_point(street_norm TEXT, street_key TEXT, number TEXT, unit TEXT, postcode TEXT, locality_norm TEXT, street_raw TEXT, lat REAL, lon REAL, source TEXT, release TEXT)"
		)
		// street_norm is the SHARED normalizer output; "Main St" → "main street".
		d.prepare(
			"INSERT INTO address_point(street_norm, number, postcode, locality_norm, lat, lon, source, release) VALUES(?,?,?,?,?,?,?,?)"
		).run("main street", "100", "10001", "new york", 40.75, -73.99, "overture:test", "2026-05-20.0")
	})
}

function interpDb(): DatabaseSync {
	return db((d) => {
		d.exec(
			"CREATE TABLE street_segment(street_norm TEXT, from_hn INTEGER, to_hn INTEGER, min_hn INTEGER, max_hn INTEGER, parity TEXT, postcode TEXT, geometry TEXT, source TEXT, release TEXT)"
		)
		// A 100→200 even-side segment, a straight ~1km polyline.
		d.prepare("INSERT INTO street_segment VALUES(?,?,?,?,?,?,?,?,?,?)").run(
			"main street",
			100,
			200,
			100,
			200,
			"even",
			"10001",
			JSON.stringify([
				[-73.99, 40.75],
				[-73.98, 40.75],
			]),
			"tiger:edges",
			"TIGER2023"
		)
	})
}

describe("HttpvfsAddressPointLookup", () => {
	test("finds an exact point by postcode + street + number", async () => {
		const lk = new HttpvfsAddressPointLookup(stubWorker(situsDb()))
		const hit = await lk.find({ street: "Main St", number: "100", postcode: "10001" })
		expect(hit).toMatchObject({ lat: 40.75, lon: -73.99, source: "overture:test" })
	})

	test("falls back to locality scope when no postcode hit", async () => {
		const lk = new HttpvfsAddressPointLookup(stubWorker(situsDb()))
		const hit = await lk.find({ street: "Main St", number: "100", locality: "New York" })
		expect(hit?.lat).toBe(40.75)
	})

	test("returns null on a miss and on a tableless shard", async () => {
		const lk = new HttpvfsAddressPointLookup(stubWorker(situsDb()))
		expect(await lk.find({ street: "Main St", number: "999", postcode: "10001" })).toBeNull()
		const empty = new HttpvfsAddressPointLookup(stubWorker(db((d) => d.exec("CREATE TABLE _x(a)"))))
		expect(await empty.find({ street: "Main St", number: "100", postcode: "10001" })).toBeNull()
	})
})

describe("HttpvfsInterpolator", () => {
	test("interpolates a house number within a segment range", async () => {
		const lk = new HttpvfsInterpolator(stubWorker(interpDb()))
		const hit = await lk.find({ street: "Main St", number: "150", postcode: "10001" }) // even, mid-range
		expect(hit?.interpolated).toBe(true)
		expect(hit?.method).toBe("tiger_range")
		expect(hit?.parityMatched).toBe(true)
		// 150 is the midpoint of 100..200 → ~halfway along the polyline (lon ~ -73.985)
		expect(hit!.lon).toBeGreaterThan(-73.99)
		expect(hit!.lon).toBeLessThan(-73.98)
		expect(hit!.uncertaintyM).toBeGreaterThan(0)
	})

	test("rejects non-numeric house numbers and tableless shards", async () => {
		const lk = new HttpvfsInterpolator(stubWorker(interpDb()))
		expect(await lk.find({ street: "Main St", number: "12B", postcode: "10001" })).toBeNull()
		const empty = new HttpvfsInterpolator(stubWorker(db((d) => d.exec("CREATE TABLE _x(a)"))))
		expect(await empty.find({ street: "Main St", number: "150", postcode: "10001" })).toBeNull()
	})
})

describe("resolveStreet", () => {
	const situsHit = { find: async () => ({ lat: 1, lon: 2 }) }
	const situsMiss = { find: async () => null }
	const interpHit = { find: async () => ({ lat: 3, lon: 4, uncertaintyM: 100 }) }
	const interpMiss = { find: async () => null }

	test("situs wins with a 10 m floor", async () => {
		const r = await resolveStreet("Main St", "100", "10001", "NYC", situsHit, interpHit)
		expect(r).toEqual({ lat: 1, lon: 2, tier: "address_point", uncertaintyM: 10 })
	})

	test("falls back to interp with the calibrated radius", async () => {
		const r = await resolveStreet("Main St", "150", "10001", "NYC", situsMiss, interpHit, 1.5)
		expect(r).toEqual({ lat: 3, lon: 4, tier: "interpolated", uncertaintyM: 150 }) // 100 × 1.5
	})

	test("returns null when both tiers miss, or when there's no street/number", async () => {
		expect(await resolveStreet("Main St", "150", "10001", "NYC", situsMiss, interpMiss)).toBeNull()
		expect(await resolveStreet(undefined, "150", "10001", "NYC", situsHit, interpHit)).toBeNull()
		expect(await resolveStreet("Main St", "", "10001", "NYC", situsHit, interpHit)).toBeNull()
	})
})
