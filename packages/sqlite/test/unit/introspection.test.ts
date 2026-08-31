/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { countRows, DatabaseClient, tableExists } from "@mailwoman/sqlite"
import { describe, expect, it } from "vitest"

interface Schema {
	place: { id: number }
}

describe("introspection", () => {
	it("tableExists answers for tables only", () => {
		using db = new DatabaseClient<Schema>(":memory:")

		db.exec("CREATE TABLE place (id INTEGER PRIMARY KEY); CREATE INDEX place_idx ON place (id)")

		expect(tableExists(db, "place")).toBe(true)
		expect(tableExists(db, "place_idx")).toBe(false)
		expect(tableExists(db, "missing")).toBe(false)
	})

	it("countRows counts the table", () => {
		using db = new DatabaseClient<Schema>(":memory:")

		db.exec("CREATE TABLE place (id INTEGER PRIMARY KEY); INSERT INTO place VALUES (1), (2), (3)")

		expect(countRows(db, "place")).toBe(3)
	})
})
