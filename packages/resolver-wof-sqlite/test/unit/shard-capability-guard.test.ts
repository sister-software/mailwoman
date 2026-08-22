/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file #1791 — a shard that cannot serve a lookup should say so at construction, not by going quiet.
 *
 *   Both ways it failed before were hard to read. An unroutable name returned zero hits, which is indistinguishable
 *   from "this country has no places" — `postcode-ca-overture.db` holds 843,739 Canadian postcodes and answered
 *   `M1J1A8` with nothing, because `startsWith("postalcode_")` never matches `postcode_ca_overture`. A routable name
 *   threw from deep inside a SELECT instead.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { WOFSqlitePlaceLookup } from "@mailwoman/resolver-wof-sqlite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

let dir: string

/**
 * A main shard complete enough to construct against.
 */
const writeMain = (path: string): void => {
	const db = new DatabaseSync(path)

	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL, min_latitude REAL, min_longitude REAL, max_latitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER, is_ceased INTEGER, is_superseded INTEGER, is_superseding INTEGER
		);

		CREATE VIRTUAL TABLE place_search USING fts5(wof_id UNINDEXED, name, alt_names);
		CREATE TABLE names (id INTEGER, name TEXT, lang TEXT);
	`)

	db.close()
}

/**
 * A shard that CLAIMS to be a place shard — it carries `spr` — and cannot serve one.
 */
const writeSprOnly = (path: string): void => {
	const db = new DatabaseSync(path)

	db.exec(
		`CREATE TABLE spr (id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT, latitude REAL, longitude REAL)`
	)

	db.close()
}

/**
 * A relation-table shard, which never claims to be a place shard and is part of the documented default set.
 */
const writeRelationOnly = (path: string): void => {
	const db = new DatabaseSync(path)

	db.exec(
		`CREATE TABLE postcode_locality (postcode TEXT, locality_id INTEGER, is_containing INTEGER, distance_km REAL)`
	)

	db.close()
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "shard-guard-"))

	writeMain(join(dir, "admin.db"))
	// Routes by name (`postalcode_x` starts with `postalcode_`), so the old failure was a mid-query throw.
	writeSprOnly(join(dir, "postalcode-x.db"))
	// Routes NOWHERE — the CA case, spelled `postcode` where the placetype is `postalcode`.
	writeSprOnly(join(dir, "postcode-ca-overture.db"))
	writeRelationOnly(join(dir, "postcode-locality-intl.db"))
})

afterAll(() => {
	rmSync(dir, { recursive: true, force: true })
})

describe("shard capability guard", () => {
	it("constructs against a complete shard set", () => {
		expect(() => new WOFSqlitePlaceLookup({ databasePath: [join(dir, "admin.db")] })).not.toThrow()
	})

	it("refuses a shard that carries spr and no place_search", () => {
		expect(
			() => new WOFSqlitePlaceLookup({ databasePath: [join(dir, "admin.db"), join(dir, "postalcode-x.db")] })
		).toThrow(/carries "spr" but no "place_search"/)
	})

	it("names the routing problem too when the schema name matches no placetype", () => {
		let message = ""

		try {
			new WOFSqlitePlaceLookup({ databasePath: [join(dir, "admin.db"), join(dir, "postcode-ca-overture.db")] })
		} catch (error) {
			message = (error as Error).message
		}

		expect(message).toMatch(/carries "spr" but no "place_search"/)
		// The half that turns "zero hits" into a diagnosis: this shard would never have been queried anyway.
		expect(message).toMatch(/matches no routed placetype/)
		expect(message).toContain("postcode_ca_overture")
	})

	it("says nothing about a shard that routes, when it only lacks the table", () => {
		let message = ""

		try {
			new WOFSqlitePlaceLookup({ databasePath: [join(dir, "admin.db"), join(dir, "postalcode-x.db")] })
		} catch (error) {
			message = (error as Error).message
		}

		expect(message).not.toMatch(/matches no routed placetype/)
	})

	it("EXEMPTS a relation-table shard, which is in the documented default set", () => {
		// `postcode-locality-<cc>.db` has no `spr`, so it never claims to be a place shard. Guarding on the filename
		// rather than on the table would have broken the shipped default.
		expect(
			() => new WOFSqlitePlaceLookup({ databasePath: [join(dir, "admin.db"), join(dir, "postcode-locality-intl.db")] })
		).not.toThrow()
	})

	it("does not examine the MAIN shard for routing — it is the fallback by definition", () => {
		expect(() => new WOFSqlitePlaceLookup({ databasePath: [join(dir, "admin.db")] })).not.toThrow()
	})
})
