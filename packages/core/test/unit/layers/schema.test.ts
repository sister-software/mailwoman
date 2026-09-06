/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLayerCoverage, writeLayerCoverage } from "@mailwoman/core/layers/manifest"
import {
	createLayerCoverageTable,
	createLayerManifestTable,
	LayerTier,
	type LayerContractDatabase,
} from "@mailwoman/core/layers/schema"
import { supportsExclusion, CoverageBasis } from "@mailwoman/evidence"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sql } from "kysely"
import { describe, expect, it } from "vitest"

function openMemoryDB(): DatabaseClient<LayerContractDatabase> {
	return DatabaseClient.temp<LayerContractDatabase>()
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
			.values({ h3_cell: 123_456_789, completeness: 0.42, observed_rows: 17 })
			.execute()

		const cell = await db.selectFrom("layer_coverage").selectAll().executeTakeFirstOrThrow()
		expect(cell.completeness).toBeCloseTo(0.42)
	})

	describe("coverage basis — what a completeness value rests on", () => {
		it("reads a row written without a basis as source_present, the weakest reading", async () => {
			using db = openMemoryDB()
			await createLayerCoverageTable(db)

			// A pre-basis artifact: the column exists, the builder never wrote it.
			await db
				.insertInto("layer_coverage")
				.values({ h3_cell: 1, completeness: 1, basis: null, observed_rows: 9 })
				.execute()

			const cell = await readLayerCoverage(db, 1)

			expect(cell?.basis).toBe(CoverageBasis.SourcePresent)
		})

		it("defaults an omitted basis to source_present on write", async () => {
			using db = openMemoryDB()
			await createLayerCoverageTable(db)
			await writeLayerCoverage(db, [{ h3Cell: 2, completeness: 1, observedRows: 3 }])

			expect((await readLayerCoverage(db, 2))?.basis).toBe(CoverageBasis.SourcePresent)
		})

		it("round-trips a declared basis", async () => {
			using db = openMemoryDB()
			await createLayerCoverageTable(db)

			await writeLayerCoverage(db, [
				{ h3Cell: 3, completeness: 1, basis: CoverageBasis.Designated, observedRows: 40 },
				{ h3Cell: 4, completeness: 0.8, basis: CoverageBasis.Surveyed, observedRows: 12 },
			])

			expect((await readLayerCoverage(db, 3))?.basis).toBe(CoverageBasis.Designated)
			expect((await readLayerCoverage(db, 4))?.basis).toBe(CoverageBasis.Surveyed)
		})

		it("permits an exclusion only on a designated or surveyed basis", () => {
			// The whole point of the column: completeness 1.0 is identical across all three, and only
			// two of them license "the thing you asked for is not here".
			expect(supportsExclusion({ basis: CoverageBasis.Designated })).toBe(true)
			expect(supportsExclusion({ basis: CoverageBasis.Surveyed })).toBe(true)
			expect(supportsExclusion({ basis: CoverageBasis.SourcePresent })).toBe(false)
			// An unread/absent basis is never strong enough either.
			expect(supportsExclusion({})).toBe(false)
		})
	})
})
