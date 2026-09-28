/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file An extract that cannot serve a lookup should say so at construction rather than by going quiet.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { WOFSQLitePlaceLookup } from "@mailwoman/resolver-wof-sqlite"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

let dir: TemporaryDirectory

const writeMain = (path: PathBuilderLike): void => {
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

const writeSprOnly = (path: PathBuilderLike): void => {
	using db = new DatabaseClient<WOFDatabase>(path)

	db.exec(
		`CREATE TABLE spr (id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT, latitude REAL, longitude REAL)`
	)
}

const writeEmpty = (path: PathBuilderLike): void => {
	new DatabaseClient<WOFDatabase>(path).destroy()
}

const writeRelationOnly = (path: PathBuilderLike): void => {
	using db = new DatabaseClient<WOFDatabase>(path)

	db.exec(
		`CREATE TABLE postcode_locality (postcode TEXT, locality_id INTEGER, is_containing INTEGER, distance_km REAL)`
	)
}

beforeAll(async () => {
	dir = await temporaryDirectory("extract-guard-")

	writeMain(dir.path("admin.db"))
	writeSprOnly(dir.path("postalcode-x.db"))
	writeSprOnly(dir.path("postcode-x.db"))
	writeRelationOnly(dir.path("postcode-locality-intl.db"))
	writeEmpty(dir.path("postalcode-empty.db"))
})

afterAll(() => dir[Symbol.asyncDispose]())

describe("extract capability guard", () => {
	it("constructs against a complete extract set", () => {
		expect(() => new WOFSQLitePlaceLookup({ databasePath: [dir.path("admin.db")] })).not.toThrow()
	})

	it("refuses an extract that carries spr and no place_search", () => {
		expect(
			() => new WOFSQLitePlaceLookup({ databasePath: [dir.path("admin.db"), dir.path("postalcode-x.db")] })
		).toThrow(/carries "spr" but no "place_search"/)
	})

	it("names the routing problem too when the schema name matches no placetype", () => {
		let message = ""

		try {
			new WOFSQLitePlaceLookup({ databasePath: [dir.path("admin.db"), dir.path("postcode-x.db")] })
		} catch (error) {
			message = (error as Error).message
		}

		expect(message).toMatch(/carries "spr" but no "place_search"/)
		expect(message).toMatch(/matches no routed placetype/)
		expect(message).toContain("postcode_x")
	})

	it("says nothing about an extract that routes, when it only lacks the table", () => {
		let message = ""

		try {
			new WOFSQLitePlaceLookup({ databasePath: [dir.path("admin.db"), dir.path("postalcode-x.db")] })
		} catch (error) {
			message = (error as Error).message
		}

		expect(message).not.toMatch(/matches no routed placetype/)
	})

	it("EXEMPTS a relation-table extract, which is in the documented default set", () => {
		expect(
			() => new WOFSQLitePlaceLookup({ databasePath: [dir.path("admin.db"), dir.path("postcode-locality-intl.db")] })
		).not.toThrow()
	})

	it("does not examine the MAIN extract for routing — it is the fallback by definition", () => {
		expect(() => new WOFSQLitePlaceLookup({ databasePath: [dir.path("admin.db")] })).not.toThrow()
	})

	it("refuses an EMPTY extract whose name routes — no spr to claim with, and it would still be queried", () => {
		let message = ""

		try {
			new WOFSQLitePlaceLookup({ databasePath: [dir.path("admin.db"), dir.path("postalcode-empty.db")] })
		} catch (error) {
			message = (error as Error).message
		}

		expect(message).not.toMatch(/carries "spr"/)
		expect(message).toMatch(/named for a routed placetype/)
		expect(message).toMatch(/die mid-SELECT/)
	})
})
