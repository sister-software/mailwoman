/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { DatabaseSync } from "node:sqlite"

import { describe, expect, it } from "vitest"

import { DatabaseClient } from "../kysley/client.ts"
import {
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
})
