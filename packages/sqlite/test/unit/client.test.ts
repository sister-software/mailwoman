/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/sqlite/client"
import { describe, expect, it } from "vitest"

interface FixtureDatabase {
	fixture: { id: number }
}

async function createFixtureTable(db: DatabaseClient<FixtureDatabase>): Promise<void> {
	await db.schema
		.createTable("fixture")
		.addColumn("id", "integer", (col) => col.primaryKey())
		.execute()
}

describe("DatabaseClient construction", () => {
	it("opens from a path with no options", async () => {
		using db = DatabaseClient.temp<FixtureDatabase>()

		await createFixtureTable(db)
		await db.insertInto("fixture").values({ id: 1 }).execute()

		expect(await db.selectFrom("fixture").selectAll().execute()).toEqual([{ id: 1 }])
	})

	it("forwards native options from the path form", async () => {
		// readOnly on a fresh :memory: database has no file to open, which is exactly how we observe the option arriving.
		expect(() => new DatabaseClient<FixtureDatabase>(":memory:", { readOnly: true }).destroy()).not.toThrow()
	})

	it("adopts an existing raw handle", async () => {
		const handle = new DatabaseSync(":memory:")
		using db = new DatabaseClient<FixtureDatabase>(handle)

		await createFixtureTable(db)
		handle.exec("INSERT INTO fixture (id) VALUES (2)")

		expect(await db.selectFrom("fixture").selectAll().execute()).toEqual([{ id: 2 }])
	})

	it("still accepts a full dialect config", async () => {
		using db = new DatabaseClient<FixtureDatabase>({ database: new DatabaseSync(":memory:") })

		await createFixtureTable(db)

		expect(await db.selectFrom("fixture").selectAll().execute()).toEqual([])
	})
})
