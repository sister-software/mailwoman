/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	COVERAGE_INSERT_BATCH,
	readLayerCoverage,
	readLayerManifest,
	supportsExclusion,
	writeLayerCoverage,
	writeLayerManifest,
	type CoverageCell,
	type LayerManifest,
} from "@mailwoman/core/layers/manifest"
import {
	CoverageBasis,
	createLayerCoverageTable,
	createLayerManifestTable,
	type LayerContractDatabase,
} from "@mailwoman/core/layers/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sql } from "kysely"
import { describe, expect, it } from "vitest"

const MANIFEST: LayerManifest = {
	name: "poi",
	version: "0.1.0",
	schemaVersion: 1,
	tier: "shipped",
	license: "CDLA-Permissive-2.0",
	attribution: "Overture Maps Foundation",
	source: "overture-places",
	sourceVintage: "2026-06",
	buildCmd: "mailwoman gazetteer build poi",
	buildSHA: "deadbeef",
	freshnessPolicy: "sealed",
	spineKeys: { h3: { column: "h3_cell", resolution: 13 }, wofID: "wof_id" },
	createdAt: "2026-07-18T00:00:00Z",
}

async function openContractDB(): Promise<DatabaseClient<LayerContractDatabase>> {
	const db = new DatabaseClient<LayerContractDatabase>(":memory:")
	await createLayerManifestTable(db)
	await createLayerCoverageTable(db)

	return db
}

describe("layer manifest IO", () => {
	it("round-trips a manifest", async () => {
		using db = await openContractDB()
		await writeLayerManifest(db, MANIFEST)
		const back = await readLayerManifest(db)
		expect(back).toEqual(MANIFEST)
	})

	it("rejects an unknown tier at write time", async () => {
		using db = await openContractDB()
		const offContract: Omit<LayerManifest, "tier"> & { tier: string } = { ...MANIFEST, tier: "bootleg" }

		await expect(writeLayerManifest(db, offContract as LayerManifest)).rejects.toThrow(/tier/)
	})

	it("rejects a manifest with no spine keys", async () => {
		using db = await openContractDB()
		await expect(writeLayerManifest(db, { ...MANIFEST, spineKeys: {} })).rejects.toThrow(/spine/)
	})

	it("throws when reading a database with no manifest", async () => {
		using db = await openContractDB()
		await expect(readLayerManifest(db)).rejects.toThrow(/manifest/)
	})

	it("round-trips a manifest with attribution absent", async () => {
		using db = await openContractDB()
		const { attribution: _attribution, ...manifestWithoutAttribution } = MANIFEST
		await writeLayerManifest(db, manifestWithoutAttribution)
		const back = await readLayerManifest(db)
		expect(back).toEqual(manifestWithoutAttribution)
		expect("attribution" in back).toBe(false)
	})
})

describe("layer coverage IO", () => {
	it("round-trips cells and returns undefined for unsurveyed cells", async () => {
		using db = await openContractDB()

		await writeLayerCoverage(db, [
			{ h3Cell: 1001, completeness: 0.9, observedRows: 240 },
			{ h3Cell: 1002, completeness: 0.1, observedRows: 3 },
		])

		expect(await readLayerCoverage(db, 1001)).toEqual({
			h3Cell: 1001,
			completeness: 0.9,
			basis: CoverageBasis.SourcePresent,
			observedRows: 240,
		})

		// Meaning-of-zero: an unsurveyed cell is UNKNOWN (undefined), never a zero-completeness record.
		expect(await readLayerCoverage(db, 9999)).toBeUndefined()
	})

	it("distinguishes a surveyed-and-empty cell from an unsurveyed one", async () => {
		using db = await openContractDB()
		await writeLayerCoverage(db, [{ h3Cell: 1003, completeness: 0, observedRows: 0 }])

		expect(await readLayerCoverage(db, 1003)).toEqual({
			h3Cell: 1003,
			completeness: 0,
			basis: CoverageBasis.SourcePresent,
			observedRows: 0,
		})
	})

	it("chunks inserts past a single statement's bound-variable limit", async () => {
		using db = await openContractDB()
		// Continental-scale coverage: spans two full batches plus a partial third, per COVERAGE_INSERT_BATCH.
		const cellCount = COVERAGE_INSERT_BATCH * 2 + 17

		const cells = Array.from({ length: cellCount }, (_, i) => ({
			h3Cell: i,
			completeness: i / cellCount,
			observedRows: i,
		}))

		await writeLayerCoverage(db, cells)

		// First cell.
		expect(await readLayerCoverage(db, 0)).toEqual({
			h3Cell: 0,
			completeness: 0,
			basis: CoverageBasis.SourcePresent,
			observedRows: 0,
		})

		// Mid-second-batch cell.
		const midSecondBatch = COVERAGE_INSERT_BATCH + Math.floor(COVERAGE_INSERT_BATCH / 2)

		expect(await readLayerCoverage(db, midSecondBatch)).toEqual({
			h3Cell: midSecondBatch,
			completeness: midSecondBatch / cellCount,
			basis: CoverageBasis.SourcePresent,
			observedRows: midSecondBatch,
		})

		// Final cell (in the trailing partial batch).
		const lastCell = cellCount - 1

		expect(await readLayerCoverage(db, lastCell)).toEqual({
			h3Cell: lastCell,
			completeness: lastCell / cellCount,
			basis: CoverageBasis.SourcePresent,
			observedRows: lastCell,
		})

		// Missing cell.
		expect(await readLayerCoverage(db, cellCount + 1000)).toBeUndefined()
	})
})

describe("coverage cell invariants", () => {
	it("round-trips an exclusion-grade cell and answers supportsExclusion for it", async () => {
		using db = await openContractDB()

		await writeLayerCoverage(db, [
			{ h3Cell: 7, completeness: 0.6665, basis: CoverageBasis.Surveyed, observedRows: 0 },
			{ h3Cell: 8, completeness: 1, basis: CoverageBasis.Designated, observedRows: 3 },
			{ h3Cell: 9, completeness: 1, basis: CoverageBasis.SourcePresent, observedRows: 3 },
		])

		expect(supportsExclusion((await readLayerCoverage(db, 7))!)).toBe(true)
		expect(supportsExclusion((await readLayerCoverage(db, 8))!)).toBe(true)
		expect(supportsExclusion((await readLayerCoverage(db, 9))!)).toBe(false)
	})

	it("refuses a completeness outside [0, 1] at write time", async () => {
		using db = await openContractDB()

		await expect(writeLayerCoverage(db, [{ h3Cell: 1, completeness: 1.5, observedRows: 1 }])).rejects.toThrow(
			/completeness/
		)

		await expect(writeLayerCoverage(db, [{ h3Cell: 1, completeness: -0.1, observedRows: 1 }])).rejects.toThrow(
			/completeness/
		)

		await expect(writeLayerCoverage(db, [{ h3Cell: 1, completeness: Number.NaN, observedRows: 1 }])).rejects.toThrow(
			/completeness/
		)
	})

	it("refuses an unknown basis at write time", async () => {
		using db = await openContractDB()

		const offContract: Omit<CoverageCell, "basis"> & { basis: string } = {
			h3Cell: 1,
			completeness: 1,
			basis: "vibes",
			observedRows: 1,
		}

		await expect(writeLayerCoverage(db, [offContract as CoverageCell])).rejects.toThrow(/unknown basis/)
	})

	it("refuses a negative or fractional observed-row count", async () => {
		using db = await openContractDB()

		await expect(writeLayerCoverage(db, [{ h3Cell: 1, completeness: 1, observedRows: -1 }])).rejects.toThrow(
			/observedRows/
		)

		await expect(writeLayerCoverage(db, [{ h3Cell: 1, completeness: 1, observedRows: 1.5 }])).rejects.toThrow(
			/observedRows/
		)
	})

	it("refuses the whole batch rather than writing the well-formed half", async () => {
		using db = await openContractDB()

		await expect(
			writeLayerCoverage(db, [
				{ h3Cell: 1, completeness: 1, observedRows: 1 },
				{ h3Cell: 2, completeness: 9, observedRows: 1 },
			])
		).rejects.toThrow(/completeness/)

		expect(await readLayerCoverage(db, 1)).toBeUndefined()
	})

	it("refuses a corrupted row at READ time too", async () => {
		using db = await openContractDB()

		await writeLayerCoverage(db, [{ h3Cell: 5, completeness: 0.5, basis: CoverageBasis.Surveyed, observedRows: 2 }])

		// Corruption an in-contract writer cannot produce, standing in for a hand-built layer.
		await sql`update layer_coverage set completeness = 4.2 where h3_cell = 5`.execute(db)

		await expect(readLayerCoverage(db, 5)).rejects.toThrow(/completeness/)
	})
})

describe("SpineKeys.street — the third layer shape", () => {
	it("accepts a street spine as satisfying the at-least-one rule", async () => {
		// The contract's first three keys describe the two shapes that existed when it was written: a cellular
		// layer (poi.db, H3) and an id-joined one. The situs shards are a third — `address_point` and
		// `street_segment` carry no H3 cell, no WOF id and no address-id, and are probed on
		// (postcode | locality, street_norm, number). Before this key they could only be described by naming a
		// column that does not exist, in the field a consumer uses to join.
		const db = await openContractDB()

		await expect(
			writeLayerManifest(db, { ...MANIFEST, spineKeys: { street: { column: "street_norm" } } })
		).resolves.toBeUndefined()
	})

	it("still refuses a manifest with NO spine at all", async () => {
		const db = await openContractDB()

		await expect(writeLayerManifest(db, { ...MANIFEST, spineKeys: {} })).rejects.toThrow(/spine/)
	})
})
