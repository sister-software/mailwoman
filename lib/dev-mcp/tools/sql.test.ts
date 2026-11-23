// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * `mwdev_sql` over a database the test builds under a temporary data root.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { DevToolDeps } from "#dev-mcp/result/tool-kit"
import { sqlTool } from "#dev-mcp/tools/sql"

interface SQLReply {
	columns: string[]
	rows: Array<Record<string, unknown>>
	rowCount: number
	truncated: boolean
	limit: number
	totalRows: number
	plan: Array<{ detail: string }> | null
	durationsMs: number[]
	medianMs: number | null
}

async function runSQL(args: Record<string, unknown>, dataRoot: string): Promise<SQLReply> {
	return (await sqlTool({} as DevToolDeps, { dataRoot }).handler(args)) as SQLReply
}

interface PlaceDatabase {
	place: { id: number; name: string }
}

let scratch: TemporaryDirectory
let dataRoot: string

beforeEach(async () => {
	scratch = await temporaryDirectory("mwdev-sql-test-")
	dataRoot = scratch.path().toString()
	await makeDirectories(scratch.path("db"))

	using db = new DatabaseClient<PlaceDatabase>(scratch.path("db", "places.db").toString())

	await db.schema
		.createTable("place")
		.addColumn("id", "integer", (column) => column.primaryKey())
		.addColumn("name", "text", (column) => column.notNull())
		.execute()

	await db
		.insertInto("place")
		.values(Array.from({ length: 5 }, (_, index) => ({ id: index + 1, name: `place ${index + 1}` })))
		.execute()
})

afterEach(async () => {
	await scratch[Symbol.asyncDispose]()
})

describe("mwdev_sql", () => {
	it("caps the rows while reading, says so, and counts the rows the cap left out", async () => {
		const result = await runSQL({ database: "db/places.db", sql: "SELECT id, name FROM place", limit: 2 }, dataRoot)

		expect(result).toMatchObject({ columns: ["id", "name"], rowCount: 2, truncated: true, limit: 2, totalRows: 5 })

		expect(result.rows).toEqual([
			{ id: 1, name: "place 1" },
			{ id: 2, name: "place 2" },
		])
	})

	it("returns the query plan and one duration per run", async () => {
		const result = await runSQL(
			{ database: "db/places.db", sql: "SELECT name FROM place WHERE id = ?", params: [3], runs: 3 },
			dataRoot
		)

		expect(result.rows).toEqual([{ name: "place 3" }])
		expect(result.plan?.map((row) => row.detail)).toEqual(["SEARCH place USING INTEGER PRIMARY KEY (rowid=?)"])
		expect(result.durationsMs).toHaveLength(3)
		expect(result.medianMs).toBeTypeOf("number")
	})

	it("surfaces SQLite's read-only error for a statement that writes, with the statement", async () => {
		await expect(runSQL({ database: "db/places.db", sql: "DELETE FROM place WHERE id = 1" }, dataRoot)).rejects.toThrow(
			/"DELETE FROM place WHERE id = 1": attempt to write a readonly database/
		)
	})

	it("refuses a path outside the data root and names the resolved path", async () => {
		await expect(runSQL({ database: "../outside.db", sql: "SELECT 1" }, dataRoot)).rejects.toThrow(
			/resolves to .*outside\.db, which is outside the data root/
		)
	})

	it("refuses a second statement rather than dropping it", async () => {
		await expect(runSQL({ database: "db/places.db", sql: "SELECT 1; DELETE FROM place" }, dataRoot)).rejects.toThrow(
			/holds another after "SELECT 1;": "DELETE FROM place"/
		)
	})

	it("admits a trailing semicolon and comment after the one statement", async () => {
		const result = await runSQL(
			{ database: "db/places.db", sql: "SELECT count(*) AS n FROM place; -- all rows" },
			dataRoot
		)

		expect(result.rows).toEqual([{ n: 5 }])
	})

	it("refuses a second statement that follows a block comment", async () => {
		await expect(
			runSQL({ database: "db/places.db", sql: "SELECT 1; /* note */ DELETE FROM place" }, dataRoot)
		).rejects.toThrow(/holds another after/)
	})

	it("reads a tail of repeated comment markers in one pass", async () => {
		// A backtracking pattern over this tail takes time exponential in the repetitions.
		const tail = `/*${"*//*".repeat(5000)}`
		const startedAt = performance.now()
		const result = await runSQL({ database: "db/places.db", sql: `SELECT count(*) AS n FROM place; ${tail}` }, dataRoot)

		expect(result.rows).toEqual([{ n: 5 }])
		expect(performance.now() - startedAt).toBeLessThan(2000)
	})
})
