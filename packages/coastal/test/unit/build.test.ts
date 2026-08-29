/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The fixture rung: build a real sealed artifact from hand-built geometry, then read it.
 *
 *   THE MEANING-OF-ZERO INVERSION IS THE POINT OF THIS FILE, and it is checked in three ways rather than
 *   asserted once. Every coverage row must fail `supportsExclusion`; a builder handing a stronger basis to
 *   the coverage writer must be refused; and an artifact carrying one must be refused at open time. The
 *   sibling flood layer reports a point inside its footprint and outside every polygon as the authority's
 *   Zone 1 DESIGNATION. This layer must report the same geometry as `unknown` with no designation, because
 *   NCERM publishes no coverage statement and an absent polygon may simply be inland.
 *
 *   THE TWELVE SCENARIOS STAYING SEPARABLE IS THE SECOND THING PINNED HERE. The fixture puts two scenarios
 *   over the SAME ground with different distances, so a build that pooled them would answer one point with
 *   two contradictory numbers under one name.
 */

import { CoastalContainmentPath, CoastalErosionLookup, CoastalReadingKind } from "@mailwoman/coastal"
import type { CoastalDatabase } from "@mailwoman/coastal/schema"
import {
	assertNoNegativeClaim,
	buildCoastalDatabase,
	type BuildCoastalResult,
} from "@mailwoman/coastal/sdk/build-coastal"
import type { CoastalSourceFeature } from "@mailwoman/coastal/sdk/ingest"
import {
	fixtureFeature,
	fixtureFeatures,
	fixtureInstabilityFeatures,
	fixtureSource,
	FIXTURE_ORIGIN,
	FIXTURE_SCENARIOS,
	FIXTURE_SIDE,
	rectangleRing,
} from "@mailwoman/coastal/test-kit"
import { NCERM_LAYER_NAME } from "@mailwoman/coastal/vocabulary"
import { CoverageBasis, supportsExclusion } from "@mailwoman/core/layers"
import { mkdtempSync, rmSync, statSync } from "@mailwoman/platform/fs"
import { tmpdir } from "@mailwoman/platform/os"
import { join } from "@mailwoman/platform/path"
import { DatabaseSync } from "@mailwoman/platform/sqlite"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const INDEX_RESOLUTION = 10
const COVERAGE_RESOLUTION = 6

const NFI = FIXTURE_SCENARIOS.noIntervention.key
const SMP = FIXTURE_SCENARIOS.withPlan.key

let scratch: string
let databasePath: string
let result: BuildCoastalResult
let lookup: CoastalErosionLookup

/**
 * A point inside the first fixture band — where both scenarios have a polygon.
 */
const INSIDE_BAND_A = {
	latitude: FIXTURE_ORIGIN.lat + FIXTURE_SIDE / 2,
	longitude: FIXTURE_ORIGIN.lon + FIXTURE_SIDE / 2,
}

/**
 * A point far from every fixture band, in the same waters.
 */
const OUTSIDE_EVERY_BAND = {
	latitude: FIXTURE_ORIGIN.lat + 0.2,
	longitude: FIXTURE_ORIGIN.lon + 0.2,
}

/**
 * Build one artifact from a feature list, into its own scratch directory.
 */
async function build(
	features: CoastalSourceFeature[] = fixtureFeatures(),
	out = "coastal-england.db"
): Promise<{ path: string; result: BuildCoastalResult }> {
	const path = join(scratch, out)

	const built = await buildCoastalDatabase({
		source: fixtureSource(features),
		out: path,
		sourceVintage: "2024-11-28",
		buildCmd: "vitest",
		buildSHA: "fixture",
		createdAt: "2026-08-28T00:00:00.000Z",
		indexResolution: INDEX_RESOLUTION,
		coverageResolution: COVERAGE_RESOLUTION,
	})

	return { path, result: built }
}

beforeAll(async () => {
	scratch = mkdtempSync(join(tmpdir(), "mw-coastal-"))

	const built = await build()

	databasePath = built.path
	result = built.result
	lookup = new CoastalErosionLookup({ databasePath })
}, 120_000)

afterAll(() => {
	lookup?.close()
	rmSync(scratch, { recursive: true, force: true })
})

describe("the sealed artifact", () => {
	it("writes every fixture feature and seals the file read-only", () => {
		expect(result.erosionFeatures).toBe(5)
		expect(result.instabilityFeatures).toBe(1)
		expect(result.scenarioCounts[NFI]).toBe(4)
		expect(result.scenarioCounts[SMP]).toBe(1)

		// 0o444 — sealed, per the layer contract's build-then-swap discipline.
		expect(statSync(databasePath).mode & 0o777).toBe(0o444)
	})

	it("declares the layer, its index resolution and its licence in the manifest", () => {
		expect(lookup.identity.manifest.name).toBe(NCERM_LAYER_NAME)
		expect(lookup.identity.manifest.spineKeys.h3?.column).toBe("coastal_zone_cell.h3_cell")
		expect(lookup.identity.indexResolution).toBe(INDEX_RESOLUTION)
		expect(lookup.identity.coverageResolution).toBe(COVERAGE_RESOLUTION)
		expect(lookup.identity.manifest.license).toBe("OGL-UK-3.0")
		expect(lookup.identity.manifest.attribution).toContain("Environment Agency")
	})

	it("keys the truth table by scenario and by the authority's feature id, never by the frontage", () => {
		const database = new DatabaseClient<CoastalDatabase>(databasePath, { readOnly: true })

		try {
			const rows = database.prepare("SELECT area_id, scenario_key, frontage_id FROM coastal_zone_area").all() as Array<{
				area_id: string
				scenario_key: string
				frontage_id: number
			}>

			// Every fixture feature carries frontage 1000 — the real product repeats a frontage id within one layer, and a
			// build keyed on it would have collapsed five rows into one.
			expect(new Set(rows.map((row) => row.frontage_id))).toEqual(new Set([1000]))
			expect(rows).toHaveLength(5)
			expect(new Set(rows.map((row) => row.area_id)).size).toBe(5)
			expect(rows.filter((row) => row.scenario_key === NFI)).toHaveLength(4)
		} finally {
			database.destroy()
		}
	})

	it("indexes a polygon narrower than a cell rather than dropping it", () => {
		const database = new DatabaseClient<CoastalDatabase>(databasePath, { readOnly: true })

		try {
			const sliver = database
				.prepare("SELECT count(*) AS n FROM coastal_zone_cell WHERE area_id = ?")
				.get(`${NFI}:4`) as { n: number }

			// A polyfill keyed on cell centres returns nothing for a 5 m square, and a feature indexed to nothing reads
			// downstream as an absence — the failure the per-part zero-cell guard exists to make impossible.
			expect(sliver.n).toBeGreaterThan(0)
		} finally {
			database.destroy()
		}
	})
})

describe("scenario scoping", () => {
	it("answers the same coordinate differently under two scenarios, each naming its own", () => {
		const underNFI = lookup.lookup(INSIDE_BAND_A.latitude, INSIDE_BAND_A.longitude, NFI)
		const underSMP = lookup.lookup(INSIDE_BAND_A.latitude, INSIDE_BAND_A.longitude, SMP)

		expect(underNFI.kind).toBe(CoastalReadingKind.Designated)
		expect(underSMP.kind).toBe(CoastalReadingKind.Designated)

		expect(underNFI.scenario.key).toBe(NFI)
		expect(underSMP.scenario.key).toBe(SMP)

		expect(underNFI.designations.map((designation) => designation.distanceM)).toEqual([12])
		expect(underSMP.designations.map((designation) => designation.distanceM)).toEqual([310])
	})

	it("carries the shoreline-management policy only where the scenario has one", () => {
		const underNFI = lookup.lookup(INSIDE_BAND_A.latitude, INSIDE_BAND_A.longitude, NFI)
		const underSMP = lookup.lookup(INSIDE_BAND_A.latitude, INSIDE_BAND_A.longitude, SMP)

		expect(underNFI.designations[0]!.policy).toBeUndefined()
		expect(underSMP.designations[0]!.policy?.mediumTermInterpretation).toBe("Erosion restricted")
	})

	it("refuses a probe naming a scenario the layer does not hold", () => {
		expect(() => lookup.lookup(INSIDE_BAND_A.latitude, INSIDE_BAND_A.longitude, "SMP_2105_50CC")).toThrow(
			/not a scenario this layer holds/u
		)
	})

	it("answers a point inside a hole as outside the polygon", () => {
		const holeCentre = {
			latitude: FIXTURE_ORIGIN.lat + 2.5 * FIXTURE_SIDE,
			longitude: FIXTURE_ORIGIN.lon + FIXTURE_SIDE / 2,
		}

		expect(lookup.lookup(holeCentre.latitude, holeCentre.longitude, NFI).kind).toBe(CoastalReadingKind.Unknown)
	})
})

describe("the meaning-of-zero inversion", () => {
	it("reads a point outside every polygon as unknown, never as an absence designation", () => {
		const reading = lookup.lookup(OUTSIDE_EVERY_BAND.latitude, OUTSIDE_EVERY_BAND.longitude, NFI)

		expect(reading.kind).toBe(CoastalReadingKind.Unknown)
		expect(reading.designations).toEqual([])
		expect(reading.containment).toBe(CoastalContainmentPath.NoZoneCell)
		expect(reading.coverageLimit).toMatch(/no coverage statement/u)
	})

	it("names its scenario even on an unknown reading", () => {
		expect(lookup.lookup(OUTSIDE_EVERY_BAND.latitude, OUTSIDE_EVERY_BAND.longitude, SMP).scenario.key).toBe(SMP)
	})

	it("writes every coverage row on source_present, so none of them supports an exclusion", () => {
		const database = new DatabaseClient<CoastalDatabase>(databasePath, { readOnly: true })

		try {
			const rows = database
				.prepare("SELECT h3_cell, completeness, basis, observed_rows FROM layer_coverage")
				.all() as Array<{ h3_cell: number; completeness: number; basis: string | null; observed_rows: number }>

			expect(rows.length).toBeGreaterThan(0)
			expect(result.coverageBasis).toBe(CoverageBasis.SourcePresent)

			// THE FAILING TEST THE ISSUE ASKS FOR: not one assertion on one row, but the whole table read back and every row
			// checked through the contract's own predicate. A code path that read `supportsExclusion` as true for this layer
			// would have to make one of these rows carry a stronger basis, and this fails the moment it does.
			for (const row of rows) {
				expect(row.basis).toBe(CoverageBasis.SourcePresent)
				expect(supportsExclusion({ basis: row.basis as CoverageBasis })).toBe(false)
				expect(row.observed_rows).toBeGreaterThan(0)
			}
		} finally {
			database.destroy()
		}
	})

	it("refuses to write a coverage row that would license a negative claim", () => {
		expect(() =>
			assertNoNegativeClaim([{ h3Cell: 1, completeness: 1, basis: CoverageBasis.Designated, observedRows: 0 }])
		).toThrow(/supports an EXCLUSION/u)

		expect(() =>
			assertNoNegativeClaim([{ h3Cell: 1, completeness: 1, basis: CoverageBasis.Surveyed, observedRows: 0 }])
		).toThrow(/supports an EXCLUSION/u)

		expect(() =>
			assertNoNegativeClaim([{ h3Cell: 1, completeness: 1, basis: CoverageBasis.SourcePresent, observedRows: 1 }])
		).not.toThrow()
	})

	it("refuses to OPEN an artifact whose coverage would license a negative claim", () => {
		const path = join(scratch, "tampered.db")

		// The sealed artifact is copied and one coverage row is promoted to `designated`, which is exactly what a builder
		// generalizing the flood layer's rule would have produced. The reader must refuse rather than answer confidently.
		const source = new DatabaseClient<CoastalDatabase>(databasePath, { readOnly: true })

		try {
			source.exec(`VACUUM INTO '${path}'`)
		} finally {
			source.destroy()
		}

		const tampered = new DatabaseClient<CoastalDatabase>(path)

		try {
			// Keyed on `h3_cell` rather than on `rowid`, because `layer_coverage` is `WITHOUT ROWID` and has none.
			tampered.exec(
				`UPDATE layer_coverage SET basis = '${CoverageBasis.Designated}' ` +
					"WHERE h3_cell = (SELECT min(h3_cell) FROM layer_coverage)"
			)
		} finally {
			tampered.destroy()
		}

		expect(() => new CoastalErosionLookup({ databasePath: path })).toThrow(/supports an EXCLUSION/u)
	})
})

describe("ground instability", () => {
	it("stores the two ground-instability layers apart and never answers an erosion question from one", () => {
		const instability = fixtureInstabilityFeatures()[0]!
		const ring = instability.polygons[0]![0]!

		const centre = {
			longitude: (ring[0]![0]! + ring[2]![0]!) / 2,
			latitude: (ring[0]![1]! + ring[2]![1]!) / 2,
		}

		expect(lookup.lookup(centre.latitude, centre.longitude, NFI).kind).toBe(CoastalReadingKind.Unknown)

		const readings = lookup.groundInstabilityAt(centre.latitude, centre.longitude)

		expect(readings).toHaveLength(1)
		expect(readings[0]!.kind).toBe("zone")
		expect(readings[0]!.location).toBe("Fixture Cliff")
	})

	it("keeps ground-instability polygons out of the erosion cell index entirely", () => {
		const database = new DatabaseClient<CoastalDatabase>(databasePath, { readOnly: true })

		try {
			const rows = database
				.prepare(
					"SELECT count(*) AS n FROM coastal_zone_cell WHERE area_id LIKE 'zone:%' OR area_id LIKE 'recession:%'"
				)
				.get() as { n: number }

			expect(rows.n).toBe(0)
		} finally {
			database.destroy()
		}
	})
})

describe("the declared domains", () => {
	it("throws on a policy value the authority never published", async () => {
		const features = fixtureFeatures()
		const withPlan = features.find((feature) => feature.scenario.key === SMP)!

		await expect(build([{ ...withPlan, mtPolicy: "Hold the Line" }], "bad-policy.db")).rejects.toThrow(
			/declared policy domain/u
		)
	})

	it("throws on a defence type outside the domain, even after case folding", async () => {
		const features = fixtureFeatures()

		await expect(
			build([{ ...features[0]!, defenceType: "Vertical Wall - Titanium" }], "bad-defence.db")
		).rejects.toThrow(/declared defence domain/u)
	})

	it("accepts the source's own inconsistent capitalization and stores it verbatim", async () => {
		const features = fixtureFeatures()
		const built = await build([{ ...features[0]!, defenceType: "Sheet piles" }], "folded-defence.db")

		const database = new DatabaseClient<CoastalDatabase>(built.path, { readOnly: true })

		try {
			const row = database.prepare("SELECT defence_type FROM coastal_zone_area").get() as { defence_type: string }

			expect(row.defence_type).toBe("Sheet piles")
		} finally {
			database.destroy()
		}
	})

	it("carries the anomalous rows as published rather than coercing them", async () => {
		const features = fixtureFeatures()
		const withPlan = features.find((feature) => feature.scenario.key === SMP)!

		const built = await build(
			[
				{
					...withPlan,
					mtPolicy: " ",
					mtPolicyInterpretation: " ",
					ltPolicy: " ",
					ltPolicyInterpretation: " ",
					defenceType: " ",
					publishedYear: 0,
				},
			],
			"anomalous.db"
		)

		const database = new DatabaseClient<CoastalDatabase>(built.path, { readOnly: true })

		try {
			const row = database.prepare("SELECT mt_policy, published_year FROM coastal_zone_area").get() as {
				mt_policy: string
				published_year: number
			}

			// A single space, not an empty string — a reader testing `=== ""` finds nothing and reports these as ordinary.
			expect(row.mt_policy).toBe(" ")
			expect(row.published_year).toBe(0)
		} finally {
			database.destroy()
		}
	})
})

describe("the area cross-check", () => {
	it("agrees with the source's own area on rings whose holes nest properly", () => {
		expect(result.area.relativeGap).toBeLessThan(0.01)
	})

	it("refuses a build whose rings do not add up to the source's own area", async () => {
		const { lon, lat } = FIXTURE_ORIGIN

		const doubled = fixtureFeature(
			9,
			FIXTURE_SCENARIOS.noIntervention,
			[[rectangleRing(lon, lat, lon + FIXTURE_SIDE, lat + FIXTURE_SIDE)]],
			// Twice the area the rings actually cover — the shape a hole read as an exterior ring produces.
			{ sourceAreaM2: 2 * 1_200_000 }
		)

		await expect(build([doubled], "bad-area.db")).rejects.toThrow(/encoded rings total/u)
	})
})
