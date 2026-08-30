/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file #1791 — a shard that cannot serve a lookup should say so at construction, not by going quiet.
 *
 *   Both ways it failed before were hard to read. An unroutable name returned zero hits, which is indistinguishable
 *   from "this country has no places": a shard reaches routing only through the name `deriveSchemaName` derives from
 *   its filename, so a file spelled one letter off the placetype it serves answers with nothing while holding every
 *   row that was asked for. A routable name threw from deep inside a SELECT instead.
 *
 *   The two `spr`-only fixtures below differ ONLY in that prefix — `postalcode-x.db` routes, `postcode-x.db` does
 *   not — so each test isolates one of the two failure modes.
 *
 *   `postalcode-empty.db` is the third case and the one the first cut missed. It carries NO tables, so a guard
 *   keyed on `spr` alone reads it as "not claiming to be a place shard" and waves it through — after which every
 *   query routed to it by its NAME dies mid-SELECT, which is the exact failure the guard exists to prevent. A
 *   zero-byte or truncated shard file is this shape, and one was on disk when the guard first shipped.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { WOFSQLitePlaceLookup } from "@mailwoman/resolver-wof-sqlite"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

let dir: TemporaryDirectory

/**
 * A main shard complete enough to construct against.
 */
const writeMain = (path: string): void => {
	using db = new DatabaseClient<WOFDatabase>(path)

	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL, min_latitude REAL, min_longitude REAL, max_latitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER, is_ceased INTEGER, is_superseded INTEGER, is_superseding INTEGER
		);

		CREATE VIRTUAL TABLE place_search USING fts5(wof_id UNINDEXED, name, alt_names);
		CREATE TABLE names (id INTEGER, name TEXT, lang TEXT);
	`)
}

/**
 * A shard that CLAIMS to be a place shard — it carries `spr` — and cannot serve one.
 */
const writeSprOnly = (path: string): void => {
	using db = new DatabaseClient<WOFDatabase>(path)

	db.exec(
		`CREATE TABLE spr (id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT, latitude REAL, longitude REAL)`
	)
}

/**
 * A shard with NOTHING in it, under a name that routes. A truncated or zero-byte file reads exactly like this.
 */
const writeEmpty = (path: string): void => {
	new DatabaseClient<WOFDatabase>(path).destroy()
}

/**
 * A relation-table shard, which never claims to be a place shard and is part of the documented default set.
 */
const writeRelationOnly = (path: string): void => {
	using db = new DatabaseClient<WOFDatabase>(path)

	db.exec(
		`CREATE TABLE postcode_locality (postcode TEXT, locality_id INTEGER, is_containing INTEGER, distance_km REAL)`
	)
}

beforeAll(async () => {
	dir = await temporaryDirectory("shard-guard-")

	writeMain(dir.resolve("admin.db"))
	// Routes by name (`postalcode_x` starts with `postalcode_`), so the old failure was a mid-query throw.
	writeSprOnly(dir.resolve("postalcode-x.db"))
	// Routes NOWHERE — spelled `postcode` where the placetype is `postalcode`.
	writeSprOnly(dir.resolve("postcode-x.db"))
	writeRelationOnly(dir.resolve("postcode-locality-intl.db"))
	// Routes by name and carries nothing at all — the shape `postalcode-fr.db` had on disk.
	writeEmpty(dir.resolve("postalcode-empty.db"))
})

afterAll(() => dir[Symbol.asyncDispose]())

describe("shard capability guard", () => {
	it("constructs against a complete shard set", () => {
		expect(() => new WOFSQLitePlaceLookup({ databasePath: [dir.resolve("admin.db")] })).not.toThrow()
	})

	it("refuses a shard that carries spr and no place_search", () => {
		expect(
			() => new WOFSQLitePlaceLookup({ databasePath: [dir.resolve("admin.db"), dir.resolve("postalcode-x.db")] })
		).toThrow(/carries "spr" but no "place_search"/)
	})

	it("names the routing problem too when the schema name matches no placetype", () => {
		let message = ""

		try {
			new WOFSQLitePlaceLookup({ databasePath: [dir.resolve("admin.db"), dir.resolve("postcode-x.db")] })
		} catch (error) {
			message = (error as Error).message
		}

		expect(message).toMatch(/carries "spr" but no "place_search"/)
		// The half that turns "zero hits" into a diagnosis: this shard would never have been queried anyway.
		expect(message).toMatch(/matches no routed placetype/)
		expect(message).toContain("postcode_x")
	})

	it("says nothing about a shard that routes, when it only lacks the table", () => {
		let message = ""

		try {
			new WOFSQLitePlaceLookup({ databasePath: [dir.resolve("admin.db"), dir.resolve("postalcode-x.db")] })
		} catch (error) {
			message = (error as Error).message
		}

		expect(message).not.toMatch(/matches no routed placetype/)
	})

	it("EXEMPTS a relation-table shard, which is in the documented default set", () => {
		// `postcode-locality-<cc>.db` has no `spr`, so it never claims to be a place shard. Guarding on the filename
		// rather than on the table would have broken the shipped default.
		expect(
			() =>
				new WOFSQLitePlaceLookup({ databasePath: [dir.resolve("admin.db"), dir.resolve("postcode-locality-intl.db")] })
		).not.toThrow()
	})

	it("does not examine the MAIN shard for routing — it is the fallback by definition", () => {
		expect(() => new WOFSQLitePlaceLookup({ databasePath: [dir.resolve("admin.db")] })).not.toThrow()
	})

	it("refuses an EMPTY shard whose name routes — no spr to claim with, and it would still be queried", () => {
		let message = ""

		try {
			new WOFSQLitePlaceLookup({ databasePath: [dir.resolve("admin.db"), dir.resolve("postalcode-empty.db")] })
		} catch (error) {
			message = (error as Error).message
		}

		// The message must NOT assert a table the file does not have. That claim was false for this shape.
		expect(message).not.toMatch(/carries "spr"/)
		expect(message).toMatch(/named for a routed placetype/)
		expect(message).toMatch(/die mid-SELECT/)
	})
})
