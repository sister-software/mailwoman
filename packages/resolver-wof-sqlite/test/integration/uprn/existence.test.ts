/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `uprnAbsenceAt` separates the two nulls, over a fixture built by the same DDL and cell derivation the builder
 *   uses, so a fixture row and a production row cannot disagree on which cell a coordinate keys to.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import {
	createLayerCoverageTable,
	createLayerManifestTable,
	LayerFreshnessPolicy,
	LayerTier,
	writeLayerCoverage,
	writeLayerManifest,
} from "@mailwoman/core/layers"
import { CoverageBasis } from "@mailwoman/evidence"
import {
	createUPRNIndexes,
	createUPRNTable,
	UPRNLookup,
	uprnAbsenceAt,
	uprnCoverageCell,
	uprnH3Cell,
	type UPRNDatabase,
} from "@mailwoman/resolver-wof-sqlite/uprn"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { join, type PathBuilderLike } from "path-ts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

/**
 * Westminster holds a point; Edinburgh is covered and empty; New York is outside coverage entirely.
 */
const WESTMINSTER = { latitude: 51.5007, longitude: -0.1246 }
const EDINBURGH = { latitude: 55.9533, longitude: -3.1883 }
const NEW_YORK = { latitude: 40.7128, longitude: -74.006 }

let dir: PathBuilderLike

beforeAll(async () => {
	dir = fixtures.use(await temporaryDirectory("uprn-existence-")).path
})

async function fixture(name: string, basis: CoverageBasis): Promise<string> {
	const path = String(join(dir, name))
	using kdb = new DatabaseClient<UPRNDatabase>(path)

	await createUPRNTable(kdb)
	await createLayerManifestTable(kdb)
	await createLayerCoverageTable(kdb)

	kdb
		.prepare("INSERT INTO uprn (uprn, lat, lon, h3_cell) VALUES (?, ?, ?, ?)")
		.run(1, WESTMINSTER.latitude, WESTMINSTER.longitude, uprnH3Cell(WESTMINSTER.latitude, WESTMINSTER.longitude))

	await createUPRNIndexes(kdb)

	await writeLayerManifest(kdb, {
		name: "os-open-uprn",
		version: "fixture",
		schemaVersion: 1,
		tier: LayerTier.BuildLocal,
		license: "OGL-UK-3.0",
		attribution: "Contains Ordnance Survey data © Crown copyright and database right 2026.",
		source: "os-open-uprn",
		sourceVintage: "2026-08",
		buildCmd: "existence.test.ts",
		buildSHA: "fixture",
		freshnessPolicy: LayerFreshnessPolicy.Sealed,
		spineKeys: { h3: { column: "h3_cell", resolution: 9 } },
		createdAt: "2026-08-18T00:00:00.000Z",
	})

	// Both cells are COVERED. Only one holds a point — that is the whole distinction under test.
	const cells = new Set([WESTMINSTER, EDINBURGH].map((p) => uprnCoverageCell(p.latitude, p.longitude)))

	await writeLayerCoverage(
		kdb,
		[...cells].map((h3Cell) => ({ h3Cell, completeness: 1, basis, observedRows: 1 }))
	)

	return path
}

async function open(name: string, basis: CoverageBasis) {
	const path = await fixture(name, basis)
	const lookup = fixtures.use(new UPRNLookup({ databasePath: path }))
	const contractDB = fixtures.use(new DatabaseClient<UPRNDatabase>(path, { readOnly: true }))

	return { lookup, contractDB }
}

describe("uprnAbsenceAt", () => {
	it("an empty DESIGNATED cell yields an exclusion", async () => {
		const deps = await open("designated.db", CoverageBasis.Designated)
		const e = await uprnAbsenceAt({ ...deps, ...EDINBURGH, radiusM: 250 })

		expect(e).not.toBeNull()
		expect(e!.scope.basis).toBe("designated")
		expect(e!.scope.layer).toBe("os-open-uprn")
		// Vintage comes from the extract's own manifest, never a literal.
		expect(e!.vintage).toBe("2026-08")
	})

	it("a point within the radius yields null — presence is not this probe's business", async () => {
		const deps = await open("present.db", CoverageBasis.Designated)

		expect(await uprnAbsenceAt({ ...deps, ...WESTMINSTER, radiusM: 250 })).toBeNull()
	})

	it("an empty SOURCE_PRESENT cell yields null — the check refuses regardless of emptiness", async () => {
		const deps = await open("sourcepresent.db", CoverageBasis.SourcePresent)

		expect(await uprnAbsenceAt({ ...deps, ...EDINBURGH, radiusM: 250 })).toBeNull()
	})

	it("a point outside any covered cell yields null — unsurveyed is unknown, not absence", async () => {
		const deps = await open("outside.db", CoverageBasis.Designated)

		expect(await uprnAbsenceAt({ ...deps, ...NEW_YORK, radiusM: 250 })).toBeNull()
	})

	it("a non-GB country yields null even inside a covered cell", async () => {
		const deps = await open("scoped.db", CoverageBasis.Designated)

		expect(await uprnAbsenceAt({ ...deps, ...EDINBURGH, radiusM: 250, country: "FR" })).toBeNull()
	})
})
