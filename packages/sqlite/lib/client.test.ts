// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { DatabaseSync } from "node:sqlite"

import { describe, expect, it } from "vitest"

import { DatabaseClient } from "#client"

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

		await expect(db.selectFrom("fixture").selectAll().execute()).resolves.toEqual([{ id: 1 }])
	})

	it("forwards native options from the path form", async () => {
		// A readOnly :memory: database opens and refuses every write.
		// The refusal shows the option arrived.
		using db = new DatabaseClient<FixtureDatabase>(":memory:", { readOnly: true })

		await expect(createFixtureTable(db)).rejects.toThrow(/readonly/)
	})

	it("adopts an existing raw handle", async () => {
		const handle = new DatabaseSync(":memory:")
		using db = new DatabaseClient<FixtureDatabase>(handle)

		await createFixtureTable(db)
		handle.exec("INSERT INTO fixture (id) VALUES (2)")

		await expect(db.selectFrom("fixture").selectAll().execute()).resolves.toEqual([{ id: 2 }])
	})

	it("still accepts a full dialect config", async () => {
		using db = new DatabaseClient<FixtureDatabase>({ database: new DatabaseSync(":memory:") })

		await createFixtureTable(db)

		await expect(db.selectFrom("fixture").selectAll().execute()).resolves.toEqual([])
	})
})
