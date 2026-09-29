/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { describe, expect, it } from "vitest"

import { DatabaseClient } from "#client"
import { SQLiteLookup, type SQLiteLookupOptions } from "#lookup"

interface FixtureDatabase {
	fixture: { id: number }
}

class FixtureLookup extends SQLiteLookup<FixtureDatabase> {
	constructor(options: SQLiteLookupOptions<FixtureDatabase>) {
		super(options)
	}

	count(): number {
		const row = this.database.prepare("SELECT count(*) AS n FROM fixture").get() as { n: number }

		return row.n
	}
}

function seed(db: DatabaseClient<FixtureDatabase>): void {
	db.exec("CREATE TABLE fixture (id INTEGER PRIMARY KEY)")
	db.exec("INSERT INTO fixture VALUES (1), (2)")
}

describe("SQLiteLookup", () => {
	it("leaves an adopted connection open after disposal", () => {
		using db = DatabaseClient.temp<FixtureDatabase>()
		seed(db)

		{
			using lookup = new FixtureLookup({ database: db })
			expect(lookup.count()).toBe(2)
		}

		expect(db.prepare("SELECT 1").get()).toEqual({ 1: 1 })
	})

	it("closes a connection it opened", async () => {
		await using dir = await temporaryDirectory("mw-sqlite-lookup-")
		const path = dir.path("fixture.db")

		{
			using db = new DatabaseClient<FixtureDatabase>(path)
			seed(db)
		}

		const lookup = new FixtureLookup({ databasePath: path })
		expect(lookup.count()).toBe(2)

		lookup[Symbol.dispose]()
		expect(() => lookup.count()).toThrow("database is not open")
	})

	it("refuses both sources and neither", () => {
		using db = DatabaseClient.temp<FixtureDatabase>()

		expect(() => new FixtureLookup({ database: db, databasePath: ":memory:" })).toThrow(/FixtureLookup: pass either/)
		expect(() => new FixtureLookup({})).toThrow(/FixtureLookup: one of/)
	})
})
