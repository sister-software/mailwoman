/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { createLayerCoverageTable, createLayerManifestTable, LayerTier } from "@mailwoman/core/layers"
import type { LayerContractDatabase } from "@mailwoman/core/layers"
import type { Kysely } from "kysely"
import { describe, expect, it } from "vitest"

import {
	BDC_COVERAGE_H3_RESOLUTION,
	BDC_H3_RESOLUTION,
	createBDCAvailabilityTable,
	createBDCGeoidIndex,
	createBDCProviderTable,
	type BDCDatabase,
} from "./schema.ts"

function openMemory(): DatabaseClient<BDCDatabase> {
	return new DatabaseClient<BDCDatabase>({ database: new DatabaseSync(":memory:") })
}

describe("bdc schema", () => {
	it("co-resides with the layer contract, accepts a typed availability row, and reads it back", async () => {
		using db = openMemory()
		// `BDCDatabase extends LayerContractDatabase` structurally, but Kysely's `transaction()` makes
		// `Kysely<DB>` INVARIANT in `DB` (see build-bdc.ts's `asContractDB` for the full rationale) —
		// narrow the handle back down for these two shared layer-contract calls.
		const contractDB = db as unknown as Kysely<LayerContractDatabase>

		await createLayerManifestTable(contractDB)
		await createLayerCoverageTable(contractDB)
		await createBDCAvailabilityTable(db)
		await createBDCProviderTable(db)
		await createBDCGeoidIndex(db)

		await db
			.insertInto("layer_manifest")
			.values({
				name: "bdc",
				version: "0.1.0",
				schema_version: 1,
				tier: LayerTier.BuildLocal,
				license: "LicenseRef-FCC-BDC-Restricted",
				attribution: "FCC Broadband Data Collection",
				source: "fcc-bdc",
				source_vintage: "2024-06",
				build_cmd: "mailwoman gazetteer build bdc",
				build_sha: "deadbeef",
				freshness_policy: "versioned-refresh",
				spine_keys: JSON.stringify({ h3: { column: "h3_cell", resolution: BDC_H3_RESOLUTION } }),
				created_at: "2026-07-30T00:00:00Z",
			})
			.execute()

		await db
			.insertInto("bdc_availability")
			.values({
				h3_cell: 123_456_789,
				geoid: "060014001001000",
				wof_id: 85_922_583,
				provider_id: 130_077,
				technology_code: 50,
				max_advertised_download_speed: 1000,
				max_advertised_upload_speed: 1000,
				low_latency: 1,
				business_residential_code: "X",
				location_id: null,
			})
			.execute()

		const row = await db.selectFrom("bdc_availability").selectAll().executeTakeFirstOrThrow()

		expect(row.geoid).toBe("060014001001000")
		expect(row.h3_cell).toBe(123_456_789)
		expect(row.wof_id).toBe(85_922_583)
		expect(row.location_id).toBeNull()

		const manifestRow = await db.selectFrom("layer_manifest").selectAll().executeTakeFirstOrThrow()
		expect(manifestRow.name).toBe("bdc")

		expect(BDC_COVERAGE_H3_RESOLUTION).toBe(6)
	})
})
