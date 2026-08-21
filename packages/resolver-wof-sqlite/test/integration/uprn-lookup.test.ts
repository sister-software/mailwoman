/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The UPRN reader's probe contract, pinned over a fixture DB built by the SAME DDL + cell
 *   derivation the real builder uses (`uprn-schema.ts`) — so a fixture row and a production row can
 *   never disagree on which cell a coordinate keys to.
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import {
	CoverageBasis,
	createLayerCoverageTable,
	createLayerManifestTable,
	LayerFreshnessPolicy,
	LayerTier,
	readLayerCoverage,
	readLayerManifest,
	writeLayerCoverage,
	writeLayerManifest,
	type LayerContractDatabase,
} from "@mailwoman/core/layers"
import { UPRN_MAX_NEAREST_RADIUS_M, UPRNLookup } from "@mailwoman/resolver-wof-sqlite/uprn-lookup"
import {
	createUPRNIndexes,
	createUPRNTable,
	uprnH3Cell,
	type UPRNDatabase,
} from "@mailwoman/resolver-wof-sqlite/uprn-schema"
import { haversineKm } from "@mailwoman/spatial"
import { beforeAll, describe, expect, it } from "vitest"

/**
 * Westminster pair ~160 m apart, plus an Edinburgh outlier — enough to exercise nearest-of-several, the radius bound,
 * and a cross-cell reach.
 */
const POINT_A = { uprn: 100_023_336_956, lat: 51.501364, lon: -0.14189 }
const POINT_B = { uprn: 10_008_905_923, lat: 51.50264, lon: -0.14089 }
const POINT_C = { uprn: 906_700_601_612, lat: 55.9533, lon: -3.1883 }

const FIXTURE_POINTS = [POINT_A, POINT_B, POINT_C]

let databasePath: string
let lookup: UPRNLookup

beforeAll(async () => {
	const dir = mkdtempSync(join(tmpdir(), "uprn-lookup-"))

	databasePath = join(dir, "uprn.db")

	const db = new DatabaseSync(databasePath)
	const kdb = new DatabaseClient<UPRNDatabase>({ database: db })
	const contract = kdb as unknown as DatabaseClient<LayerContractDatabase>

	await createUPRNTable(kdb)
	await createLayerManifestTable(contract)
	await createLayerCoverageTable(contract)

	const insert = db.prepare("INSERT INTO uprn (uprn, lat, lon, h3_cell) VALUES (?, ?, ?, ?)")

	for (const point of FIXTURE_POINTS) {
		insert.run(point.uprn, point.lat, point.lon, uprnH3Cell(point.lat, point.lon))
	}

	await createUPRNIndexes(kdb)

	await writeLayerManifest(contract, {
		name: "os-open-uprn-fixture",
		version: "fixture",
		schemaVersion: 1,
		tier: LayerTier.BuildLocal,
		license: "OGL-UK-3.0",
		attribution: "Contains Ordnance Survey data © Crown copyright and database right 2026.",
		source: "fixture",
		sourceVintage: "fixture",
		buildCmd: "uprn-lookup.test.ts",
		buildSHA: "fixture",
		freshnessPolicy: LayerFreshnessPolicy.Sealed,
		spineKeys: { h3: { column: "h3_cell", resolution: 9 } },
		createdAt: "2026-08-18T00:00:00.000Z",
	})

	await writeLayerCoverage(contract, [
		{ h3Cell: 1, completeness: 1, basis: CoverageBasis.Designated, observedRows: FIXTURE_POINTS.length },
	])

	await kdb.destroy()

	lookup = new UPRNLookup({ databasePath })
})

describe("coordinateOf", () => {
	it("returns OS's point for a known UPRN, verbatim", () => {
		expect(lookup.coordinateOf(POINT_A.uprn)).toEqual({ latitude: POINT_A.lat, longitude: POINT_A.lon })
	})

	it("returns null for a UPRN the layer does not hold", () => {
		expect(lookup.coordinateOf(999)).toBeNull()
	})
})

describe("nearestUPRN", () => {
	it("finds the point under the query coordinate", () => {
		const hit = lookup.nearestUPRN(POINT_A.lat, POINT_A.lon, 50)

		expect(hit).not.toBeNull()
		expect(hit!.uprn).toBe(POINT_A.uprn)
		expect(hit!.distanceM).toBeLessThan(1)
	})

	it("ranks by true distance when several points are in radius", () => {
		// Between A and B, nearer B — both are inside 300 m of the query.
		const query = { lat: 51.5025, lon: -0.141 }
		const hit = lookup.nearestUPRN(query.lat, query.lon, 300)

		expect(hit).not.toBeNull()
		expect(hit!.uprn).toBe(POINT_B.uprn)

		const expectedM = haversineKm(query.lat, query.lon, POINT_B.lat, POINT_B.lon) * 1000

		expect(hit!.distanceM).toBeCloseTo(expectedM, 6)
	})

	it("reaches across res-9 cell boundaries", () => {
		// ~390 m north of A — several rings away from the query's own cell at res 9.
		const hit = lookup.nearestUPRN(51.5049, -0.1419, 500)

		expect(hit).not.toBeNull()
		expect(hit!.distanceM).toBeLessThanOrEqual(500)
	})

	it("returns null when nothing lies within the radius — absence is the claim", () => {
		expect(lookup.nearestUPRN(55, -3, 1000)).toBeNull()
	})

	it("refuses a non-positive, non-finite, or over-cap radius", () => {
		expect(() => lookup.nearestUPRN(51.5, -0.14, 0)).toThrow(RangeError)
		expect(() => lookup.nearestUPRN(51.5, -0.14, -5)).toThrow(RangeError)
		expect(() => lookup.nearestUPRN(51.5, -0.14, Number.NaN)).toThrow(RangeError)
		expect(() => lookup.nearestUPRN(51.5, -0.14, UPRN_MAX_NEAREST_RADIUS_M + 1)).toThrow(RangeError)
	})
})

describe("layer contract", () => {
	it("round-trips the manifest, spine declaration included", async () => {
		const kdb = new DatabaseClient<LayerContractDatabase>({
			database: new DatabaseSync(databasePath, { readOnly: true }),
		})

		const manifest = await readLayerManifest(kdb)

		expect(manifest.name).toBe("os-open-uprn-fixture")
		expect(manifest.tier).toBe(LayerTier.BuildLocal)
		expect(manifest.spineKeys.h3).toEqual({ column: "h3_cell", resolution: 9 })

		await kdb.destroy()
	})

	it("keeps unsurveyed cells UNKNOWN — the meaning-of-zero rule", async () => {
		const kdb = new DatabaseClient<LayerContractDatabase>({
			database: new DatabaseSync(databasePath, { readOnly: true }),
		})

		const surveyed = await readLayerCoverage(kdb, 1)

		expect(surveyed?.basis).toBe(CoverageBasis.Designated)
		expect(await readLayerCoverage(kdb, 2)).toBeUndefined()

		await kdb.destroy()
	})
})
