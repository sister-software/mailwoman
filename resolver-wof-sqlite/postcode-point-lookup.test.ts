/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the SQLite-backed postcode lookup (#240). Seeds throwaway `spr` shards in tmp dirs (the
 *   real `postalcode-*.db` artifacts live on the data volume, not in CI), then asserts exact-match,
 *   the `is_current` filter, coordinate-less membership, and the cross-shard union.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { WOFPostcodeLookup } from "./postcode-point-lookup.js"

/** Create a minimal postcode shard with the columns the lookup reads. */
function seedShard(path: string, rows: Array<[number, string, string, string, number, number, number]>): void {
	const db = new DatabaseSync(path)
	db.exec(
		`CREATE TABLE spr (id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT, latitude REAL, longitude REAL, is_current INTEGER)`
	)
	const ins = db.prepare(
		`INSERT INTO spr (id, name, placetype, country, latitude, longitude, is_current) VALUES (?, ?, ?, ?, ?, ?, ?)`
	)

	for (const r of rows) {
		ins.run(...r)
	}
	db.close()
}

let dir: string
let lookup: WOFPostcodeLookup

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "mailwoman-pc-lookup-"))
	const intl = join(dir, "postalcode-intl.db")
	const us = join(dir, "postalcode-us.db")
	seedShard(intl, [
		[1, "75008", "postalcode", "FR", 48.873, 2.313, 1],
		[2, "18540", "postalcode", "DE", 53.093, 14.259, 1], // backfilled centroid
		[3, "80144", "postalcode", "IT", 0, 0, 1], // coord-less membership
		[4, "13579", "postalcode", "FR", 1, 1, 0], // not current → filtered
		[5, "Zippendorf", "postalcode", "DE", 0, 0, 0], // deprecated place-name junk → filtered
	])
	seedShard(us, [
		[10, "75008", "postalcode", "US", 35.9, -90.7, 1], // collides with FR 75008
		[11, "94105", "postalcode", "US", 37.789, -122.396, 1],
	])
	lookup = new WOFPostcodeLookup([intl, us])
})

afterAll(() => {
	lookup.close()
	rmSync(dir, { recursive: true, force: true })
})

describe("WOFPostcodeLookup", () => {
	it("exact-matches a current postcode", () => {
		expect(lookup.lookup("94105")).toEqual([{ country: "US", lat: 37.789, lon: -122.396 }])
	})

	it("returns coordinate-less rows so membership survives without a centroid", () => {
		expect(lookup.lookup("80144")).toEqual([{ country: "IT", lat: 0, lon: 0 }])
	})

	it("filters non-current rows", () => {
		expect(lookup.lookup("13579")).toEqual([])
	})

	it("returns [] for an unknown postcode", () => {
		expect(lookup.lookup("00000")).toEqual([])
	})

	it("unions the same string across shards (FR + US both own 75008)", () => {
		const countries = lookup
			.lookup("75008")
			.map((p) => p.country)
			.sort()
		expect(countries).toEqual(["FR", "US"])
	})
})
