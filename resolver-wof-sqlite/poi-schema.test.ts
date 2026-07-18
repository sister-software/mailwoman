/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { createLayerCoverageTable, createLayerManifestTable } from "@mailwoman/core/layers"
import { sql } from "kysely"
import { describe, expect, it } from "vitest"

import {
	createPOISearchFTS,
	createPOIStagingTables,
	createPOITable,
	POI_FTS_TABLE,
	type POIDatabase,
} from "./poi-schema.ts"

function openMemory(): { raw: DatabaseSync; kdb: DatabaseClient<POIDatabase> } {
	const raw = new DatabaseSync(":memory:")
	return { raw, kdb: new DatabaseClient<POIDatabase>({ database: raw }) }
}

describe("poi schema", () => {
	it("creates the clustered WITHOUT ROWID poi table with h3_cell leading the PK", async () => {
		const { kdb } = openMemory()
		await createPOITable(kdb)
		const { rows } = await sql<{ sql: string }>`select sql from sqlite_master where name = 'poi'`.execute(kdb)
		const ddl = rows[0]?.sql.toLowerCase() ?? ""
		expect(ddl).toContain("without rowid")
		expect(ddl.indexOf("h3_cell")).toBeLessThan(ddl.indexOf("category_id"))
	})

	it("stages + contract tables coexist and accept typed rows", async () => {
		const { kdb } = openMemory()
		await createPOIStagingTables(kdb)
		await createLayerManifestTable(kdb)
		await createLayerCoverageTable(kdb)
		await kdb
			.insertInto("poi_stage")
			.values({
				h3_cell: 1001,
				category_id: 3,
				brand_wikidata: "Q38076",
				name: "McDonald's",
				name_key: "mcdonalds",
				latitude: 39.78,
				longitude: -89.65,
				country: "US",
				confidence: 0.93,
				gers_id: null,
			})
			.execute()
		const row = await kdb.selectFrom("poi_stage").selectAll().executeTakeFirstOrThrow()
		expect(row.name).toBe("McDonald's")
	})

	it("creates the FTS5 name index (raw DDL — Kysely cannot express virtual tables)", async () => {
		const { raw, kdb } = openMemory()
		await createPOITable(kdb)
		createPOISearchFTS(raw)
		const found = raw.prepare("select name from sqlite_master where name = ?").get(POI_FTS_TABLE)
		expect(found).toBeDefined()
	})
})
