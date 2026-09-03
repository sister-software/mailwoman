/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The shared column runs are pinned by the STORED column order they produce, because that order is part of what a
 *   sealed layer artifact carries and what its readers see.
 */

import { DatabaseClient } from "@mailwoman/sqlite/client"
import {
	addBoundingBoxColumns,
	addCellIndexColumns,
	addRingGeometryColumns,
	addRingsColumn,
} from "@mailwoman/sqlite/schema-columns"
import { sql } from "kysely"
import { describe, expect, it } from "vitest"

async function storedColumns(build: (db: DatabaseClient<Record<string, never>>) => Promise<void>): Promise<string[]> {
	using db = new DatabaseClient<Record<string, never>>(":memory:")

	await build(db)

	const result = await sql<{ name: string }>`select name from pragma_table_info('t') order by cid`.execute(db)

	return result.rows.map((row) => row.name)
}

describe("schema-columns", () => {
	it("addBoundingBoxColumns stores the box in min/max, lat-before-lon order", async () => {
		const columns = await storedColumns((db) =>
			addBoundingBoxColumns(db.schema.createTable("t").addColumn("id", "text", (c) => c.primaryKey())).execute()
		)

		expect(columns).toEqual(["id", "min_lat", "min_lon", "max_lat", "max_lon"])
	})

	it("addRingGeometryColumns is the box followed at once by the rings blob", async () => {
		const columns = await storedColumns((db) =>
			addRingGeometryColumns(db.schema.createTable("t").addColumn("id", "text", (c) => c.primaryKey())).execute()
		)

		expect(columns).toEqual(["id", "min_lat", "min_lon", "max_lat", "max_lon", "rings"])
	})

	it("addRingsColumn lets a layer keep its own columns between the box and the blob", async () => {
		const columns = await storedColumns((db) =>
			addRingsColumn(
				addBoundingBoxColumns(db.schema.createTable("t").addColumn("id", "text", (c) => c.primaryKey())).addColumn(
					"ring_count",
					"integer",
					(c) => c.notNull()
				)
			).execute()
		)

		expect(columns).toEqual(["id", "min_lat", "min_lon", "max_lat", "max_lon", "ring_count", "rings"])
	})

	it("addCellIndexColumns places one key between the resolution and the containment", async () => {
		const columns = await storedColumns((db) => addCellIndexColumns(db.schema.createTable("t"), "area_id").execute())

		expect(columns).toEqual(["h3_cell", "resolution", "area_id", "containment"])
	})

	it("addCellIndexColumns places several keys in the order given", async () => {
		const columns = await storedColumns((db) =>
			addCellIndexColumns(db.schema.createTable("t"), ["scenario_key", "area_id"]).execute()
		)

		expect(columns).toEqual(["h3_cell", "resolution", "scenario_key", "area_id", "containment"])
	})
})
