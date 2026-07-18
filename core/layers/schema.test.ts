/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { DatabaseSync } from "node:sqlite"

import { sql } from "kysely"
import { describe, expect, it } from "vitest"

import { DatabaseClient } from "../kysley/client.ts"
import { createLayerCoverageTable, createLayerManifestTable, LayerTier, type LayerContractDatabase } from "./schema.ts"

function openMemoryDB(): DatabaseClient<LayerContractDatabase> {
	return new DatabaseClient<LayerContractDatabase>({ database: new DatabaseSync(":memory:") })
}

describe("layer contract DDL", () => {
	it("creates layer_manifest and accepts a typed row", async () => {
		using db = openMemoryDB()
		await createLayerManifestTable(db)

		await db
			.insertInto("layer_manifest")
			.values({
				name: "poi",
				version: "0.1.0",
				schema_version: 1,
				tier: LayerTier.Shipped,
				license: "CDLA-Permissive-2.0",
				attribution: "Overture Maps Foundation",
				source: "overture-places",
				source_vintage: "2026-06",
				build_cmd: "mailwoman gazetteer build poi",
				build_sha: "deadbeef",
				freshness_policy: "sealed",
				spine_keys: JSON.stringify({ h3: { column: "h3_cell", resolution: 13 } }),
				created_at: "2026-07-18T00:00:00Z",
			})
			.execute()

		const row = await db.selectFrom("layer_manifest").selectAll().executeTakeFirstOrThrow()
		expect(row.name).toBe("poi")
		expect(row.tier).toBe("shipped")
	})

	it("creates layer_coverage as a WITHOUT ROWID table keyed on h3_cell", async () => {
		using db = openMemoryDB()
		await createLayerCoverageTable(db)

		const { rows } = await sql<{ sql: string }>`select sql from sqlite_master where name = 'layer_coverage'`.execute(db)
		expect(rows[0]?.sql.toLowerCase()).toContain("without rowid")

		await db
			.insertInto("layer_coverage")
			.values({ h3_cell: 123456789, completeness: 0.42, observed_rows: 17 })
			.execute()
		const cell = await db.selectFrom("layer_coverage").selectAll().executeTakeFirstOrThrow()
		expect(cell.completeness).toBeCloseTo(0.42)
	})
})
