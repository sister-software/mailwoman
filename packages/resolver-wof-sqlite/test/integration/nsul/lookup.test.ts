/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The NSUL reader's probe contract, pinned over a fixture DB built by the SAME DDL + compact-postcode
 *   derivation the real builder uses (`nsul/schema.ts`) — so a fixture row and a production row can
 *   never disagree on the key a postcode probes by.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import {
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
import { CoverageBasis } from "@mailwoman/evidence"
import {
	compactPostcode,
	createNSULIndexes,
	createUPRNPostcodeTable,
	NSULLookup,
	type NSULDatabase,
} from "@mailwoman/resolver-wof-sqlite/nsul"
import { uprnH3Cell } from "@mailwoman/resolver-wof-sqlite/uprn"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { join } from "path-ts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

/**
 * Two Wokingham UPRNs sharing `RG40 4HR` and one Bognor Regis UPRN on `PO21 1HR` — enough to exercise the one-to-many
 * probe, its ordering, and the compact/spaced key equivalence.
 */
const ROWS = [
	{ uprn: 14_000_005, pcds: "RG40 4HR", lat: 51.37416, lon: -0.86823 },
	{ uprn: 14_000_003, pcds: "RG40 4HR", lat: 51.3742681, lon: -0.8682259 },
	{ uprn: 100_062_353_961, pcds: "PO21 1HR", lat: 50.7876, lon: -0.6717 },
]

let databasePath: string
let lookup: NSULLookup

beforeAll(async () => {
	const dir = fixtures.use(await temporaryDirectory("nsul-lookup-")).path

	databasePath = join(dir, "nsul.db")

	using kdb = new DatabaseClient<NSULDatabase>(databasePath)

	await createUPRNPostcodeTable(kdb)
	await createLayerManifestTable(kdb)
	await createLayerCoverageTable(kdb)

	const insert = kdb.prepare(
		"INSERT INTO uprn_postcode (uprn, pcds, pcds_compact, lat, lon, h3_cell) VALUES (?, ?, ?, ?, ?, ?)"
	)

	for (const row of ROWS) {
		insert.run(row.uprn, row.pcds, compactPostcode(row.pcds), row.lat, row.lon, uprnH3Cell(row.lat, row.lon))
	}

	await createNSULIndexes(kdb)

	await writeLayerManifest(kdb, {
		name: "nsul-uprn-postcode-gb-fixture",
		version: "fixture",
		schemaVersion: 1,
		tier: LayerTier.BuildLocal,
		license: "OGL-UK-3.0",
		attribution: "fixture",
		source: "fixture",
		sourceVintage: "fixture",
		buildCmd: "nsul/lookup.test.ts",
		buildSHA: "fixture",
		freshnessPolicy: LayerFreshnessPolicy.Sealed,
		spineKeys: { h3: { column: "h3_cell", resolution: 9 } },
		createdAt: "2026-09-03T00:00:00.000Z",
	})

	await writeLayerCoverage(kdb, [
		{ h3Cell: 1, completeness: 1, basis: CoverageBasis.Designated, observedRows: ROWS.length },
	])

	lookup = new NSULLookup({ databasePath })
})

describe("compactPostcode", () => {
	it("removes the space and upper-cases — Code-Point Open's spr.name form", () => {
		expect(compactPostcode("RG40 4HR")).toBe("RG404HR")
		expect(compactPostcode("po21 1hr")).toBe("PO211HR")
		expect(compactPostcode("RG404HR")).toBe("RG404HR")
	})
})

describe("postcodeForUPRN", () => {
	it("returns the register's postcode in both forms", () => {
		expect(lookup.postcodeForUPRN(14_000_003)).toEqual({ pcds: "RG40 4HR", pcdsCompact: "RG404HR" })
	})

	it("returns null for a UPRN the register does not hold", () => {
		expect(lookup.postcodeForUPRN(999)).toBeNull()
	})
})

describe("uprnsForPostcode", () => {
	it("answers every UPRN on the postcode with its point, in ascending UPRN order", () => {
		const points = lookup.uprnsForPostcode("RG404HR")

		expect(points.map((point) => point.uprn)).toEqual([14_000_003, 14_000_005])

		expect(points[0]).toEqual({
			uprn: 14_000_003,
			latitude: 51.3742681,
			longitude: -0.8682259,
			h3Cell: uprnH3Cell(51.3742681, -0.8682259),
		})
	})

	it("accepts the spaced form and the lower-cased form as the same key", () => {
		expect(lookup.uprnsForPostcode("PO21 1HR")).toEqual(lookup.uprnsForPostcode("po211hr"))
		expect(lookup.uprnsForPostcode("PO21 1HR").map((point) => point.uprn)).toEqual([100_062_353_961])
	})

	it("returns an empty array when no UPRN carries the postcode — absence is the claim", () => {
		expect(lookup.uprnsForPostcode("SW1A 1AA")).toEqual([])
	})
})

describe("layer contract", () => {
	it("round-trips the manifest, spine declaration included", async () => {
		using kdb = new DatabaseClient<LayerContractDatabase>(databasePath, { readOnly: true })

		const manifest = await readLayerManifest(kdb)

		expect(manifest.name).toBe("nsul-uprn-postcode-gb-fixture")
		expect(manifest.tier).toBe(LayerTier.BuildLocal)
		expect(manifest.spineKeys.h3).toEqual({ column: "h3_cell", resolution: 9 })
	})

	it("keeps unsurveyed cells UNKNOWN — the meaning-of-zero rule", async () => {
		using kdb = new DatabaseClient<LayerContractDatabase>(databasePath, { readOnly: true })

		expect((await readLayerCoverage(kdb, 1))?.basis).toBe(CoverageBasis.Designated)
		expect(await readLayerCoverage(kdb, 2)).toBeUndefined()
	})
})
