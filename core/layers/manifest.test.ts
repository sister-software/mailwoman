/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { DatabaseSync } from "node:sqlite"

import { describe, expect, it } from "vitest"

import { DatabaseClient } from "../kysley/client.ts"
import {
	COVERAGE_INSERT_BATCH,
	readLayerCoverage,
	readLayerManifest,
	writeLayerCoverage,
	writeLayerManifest,
	type LayerManifest,
} from "./manifest.ts"
import { createLayerCoverageTable, createLayerManifestTable, type LayerContractDatabase } from "./schema.ts"

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
	const db = new DatabaseClient<LayerContractDatabase>({ database: new DatabaseSync(":memory:") })
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
		await expect(writeLayerManifest(db, { ...MANIFEST, tier: "bootleg" as never })).rejects.toThrow(/tier/)
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
		expect(await readLayerCoverage(db, 1001)).toEqual({ h3Cell: 1001, completeness: 0.9, observedRows: 240 })
		// Meaning-of-zero: an unsurveyed cell is UNKNOWN (undefined), never a zero-completeness record.
		expect(await readLayerCoverage(db, 9999)).toBeUndefined()
	})

	it("distinguishes a surveyed-and-empty cell from an unsurveyed one", async () => {
		using db = await openContractDB()
		await writeLayerCoverage(db, [{ h3Cell: 1003, completeness: 0, observedRows: 0 }])
		expect(await readLayerCoverage(db, 1003)).toEqual({ h3Cell: 1003, completeness: 0, observedRows: 0 })
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
		expect(await readLayerCoverage(db, 0)).toEqual({ h3Cell: 0, completeness: 0, observedRows: 0 })
		// Mid-second-batch cell.
		const midSecondBatch = COVERAGE_INSERT_BATCH + Math.floor(COVERAGE_INSERT_BATCH / 2)
		expect(await readLayerCoverage(db, midSecondBatch)).toEqual({
			h3Cell: midSecondBatch,
			completeness: midSecondBatch / cellCount,
			observedRows: midSecondBatch,
		})
		// Final cell (in the trailing partial batch).
		const lastCell = cellCount - 1
		expect(await readLayerCoverage(db, lastCell)).toEqual({
			h3Cell: lastCell,
			completeness: lastCell / cellCount,
			observedRows: lastCell,
		})
		// Missing cell.
		expect(await readLayerCoverage(db, cellCount + 1000)).toBeUndefined()
	})
})
