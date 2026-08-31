/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The fixture rung: build a real sealed artifact from hand-built geometry, then read it.
 *
 *   FOUR THINGS ARE PINNED HERE AND EACH IS SILENT WHEN WRONG.
 *
 *   1. THE MEANING-OF-ZERO RULE, checked three ways rather than asserted once. Every coverage row must fail
 *      `supportsExclusion`; a builder handing a stronger basis to the coverage writer must be refused; and an
 *      artifact carrying one must be refused at OPEN time. The sibling flood layer reports a point inside its
 *      footprint and outside every polygon as the authority's Zone 1 DESIGNATION. This layer must report the
 *      same geometry as `unknown` with no designation, because a location with no zoning polygon is one of at
 *      least four different things.
 *   2. THE VOCABULARY DECISION AS STORAGE. The local code is stored byte-identically, the crosswalk sits
 *      beside it rather than instead of it, and a generic type the publisher uses without declaring is
 *      recorded as observed-but-undeclared rather than coerced or dropped.
 *   3. THE HOLE ROLES, which arrive the way the real service publishes them — each ring its own part — so a
 *      point inside a hole must read as outside the zone.
 *   4. THE TWO POSTURES THAT ARE GUARDS RATHER THAN FIELDS: the coverage basis above, and the `build-local`
 *      tier, which the builder refuses to raise while the licence is unresolved.
 */

import { statPath } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { CoverageBasis, LayerTier, supportsExclusion } from "@mailwoman/core/layers"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { ZoningContainmentPath, ZoningLookup, ZoningReadingKind } from "@mailwoman/zoning"
import type { ZoningDatabase } from "@mailwoman/zoning/schema"
import {
	assertCrosswalkIsNotATable,
	assertNoNegativeClaim,
	buildZoningDatabase,
	nonFunctionalPairs,
	type BuildZoningResult,
} from "@mailwoman/zoning/sdk/build-zoning"
import type { ZoningSourceFeature } from "@mailwoman/zoning/sdk/ingest"
import {
	exteriorRing,
	fixtureFeature,
	fixtureFeatures,
	fixtureSource,
	FIXTURE_ORIGIN,
	FIXTURE_PLANS,
	FIXTURE_SIDE,
	holeRing,
} from "@mailwoman/zoning/test-kit"
import { GZT_LAYER_NAME, GZT_LICENSE, GZT_UNZONED_LOCAL_CODE } from "@mailwoman/zoning/vocabulary"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const INDEX_RESOLUTION = 10
const COVERAGE_RESOLUTION = 6

let scratch: TemporaryDirectory
let databasePath: string
let result: BuildZoningResult
let lookup: ZoningLookup

/**
 * A point inside the first fixture zone — where both plans have a polygon.
 */
const INSIDE_ZONE_A = {
	latitude: FIXTURE_ORIGIN.lat + FIXTURE_SIDE / 2,
	longitude: FIXTURE_ORIGIN.lon + FIXTURE_SIDE / 2,
}

/**
 * A point far from every fixture zone, in the same waters.
 */
const OUTSIDE_EVERY_ZONE = {
	latitude: FIXTURE_ORIGIN.lat + 0.2,
	longitude: FIXTURE_ORIGIN.lon + 0.2,
}

/**
 * Build one artifact from a feature list, into its own scratch directory.
 */
async function build(
	features: ZoningSourceFeature[] = fixtureFeatures(),
	out = "zoning-ireland.db"
): Promise<{ path: string; result: BuildZoningResult }> {
	const path = scratch.resolve(out)

	const built = await buildZoningDatabase({
		source: fixtureSource(features),
		out: path,
		sourceVintage: "2026-05-13",
		buildCmd: "vitest",
		buildSHA: "fixture",
		createdAt: "2026-08-28T00:00:00.000Z",
		indexResolution: INDEX_RESOLUTION,
		coverageResolution: COVERAGE_RESOLUTION,
	})

	return { path, result: built }
}

beforeAll(async () => {
	scratch = await temporaryDirectory("mw-zoning-")

	const built = await build()

	databasePath = built.path
	result = built.result
	lookup = new ZoningLookup({ databasePath })
}, 120_000)

afterAll(() => {
	lookup[Symbol.dispose]()
	scratch[Symbol.asyncDispose]()
})

describe("the sealed artifact", () => {
	it("writes every fixture feature and seals the file read-only", async () => {
		expect(result.features).toBe(6)
		expect(result.jurisdictions).toBe(1)
		expect(result.plans).toBe(2)

		// 0o444 — sealed, per the layer contract's build-then-swap discipline.
		expect((await statPath(databasePath)).mode & 0o777).toBe(0o444)
	})

	it("declares the layer, its index resolution and its build-local posture in the manifest", () => {
		expect(lookup.identity.manifest.name).toBe(GZT_LAYER_NAME)
		expect(lookup.identity.manifest.spineKeys.h3?.column).toBe("zoning_cell.h3_cell")
		expect(lookup.identity.indexResolution).toBe(INDEX_RESOLUTION)
		expect(lookup.identity.coverageResolution).toBe(COVERAGE_RESOLUTION)
		expect(lookup.identity.manifest.tier).toBe(LayerTier.BuildLocal)
		expect(lookup.identity.manifest.license).toBe(GZT_LICENSE)
		expect(lookup.identity.manifest.attribution).toContain("Tailte Éireann")
	})

	it("keys the truth table by the authority's own feature id", () => {
		using database = new DatabaseClient<ZoningDatabase>(databasePath, { readOnly: true })

		const rows = database.prepare("SELECT area_id, jurisdiction_id, plan_id FROM zoning_area").all() as Array<{
			area_id: string
			jurisdiction_id: string
			plan_id: string
		}>

		expect(rows).toHaveLength(6)
		expect(new Set(rows.map((row) => row.area_id)).size).toBe(6)

		expect(new Set(rows.map((row) => row.plan_id))).toEqual(
			new Set([FIXTURE_PLANS.development.id, FIXTURE_PLANS.localArea.id])
		)
	})

	it("indexes a polygon smaller than a cell rather than dropping it", () => {
		using database = new DatabaseClient<ZoningDatabase>(databasePath, { readOnly: true })

		const sliver = database.prepare("SELECT count(*) AS n FROM zoning_cell WHERE area_id = ?").get("4") as {
			n: number
		}

		// A polyfill keyed on cell centres returns nothing for a 5 m square, and a feature indexed to nothing reads
		// downstream as an absence — the failure the per-part zero-cell guard exists to make impossible. At resolution 9,
		// that would be 86.8% of the real product's polygons.
		expect(sliver.n).toBeGreaterThan(0)
	})

	it("keeps the crosswalk edge table EMPTY, because the mapping is not a function of the pair", () => {
		using database = new DatabaseClient<ZoningDatabase>(databasePath, { readOnly: true })

		const edges = database.prepare("SELECT count(*) AS n FROM zoning_crosswalk_edge").get() as { n: number }
		const extents = database.prepare("SELECT count(*) AS n FROM zoning_mapped_extent").get() as { n: number }

		expect(edges.n).toBe(0)
		// And the footprint table too: the publisher states its coverage detail only inside a map viewer, so there is no
		// footprint to record and its emptiness is what keeps the coverage basis at `source_present`.
		expect(extents.n).toBe(0)
		expect(lookup.identity.mappedExtents).toEqual([])
	})
})

describe("the vocabulary decision", () => {
	it("stores the authority's own code byte-identically and carries the crosswalk BESIDE it", () => {
		const reading = lookup.lookup(INSIDE_ZONE_A.latitude, INSIDE_ZONE_A.longitude)
		const designation = reading.designations.find((entry) => entry.areaID === "1")

		expect(designation).toBeDefined()
		expect(designation!.localCode).toBe("R2 - Existing Residential")
		expect(designation!.crosswalk?.scheme).toBe("IE-GZT")
		expect(designation!.crosswalk?.code).toBe("R2")
		// The publisher's own label for the generic type, from its DECLARED domain.
		expect(designation!.crosswalk?.label).toBe("Existing residential")
		expect(designation!.crosswalk?.declared).toBe(true)
	})

	it("records a generic type the publisher uses without declaring, rather than coercing or dropping it", () => {
		using database = new DatabaseClient<ZoningDatabase>(databasePath, { readOnly: true })

		// Ireland declares 54 generic types and its data uses 55: `N/A` appears on a handful of rows and in no domain.
		const row = database
			.prepare("SELECT declared, observed_rows FROM zoning_vocabulary WHERE scheme = ? AND code = ?")
			.get("IE-GZT", "N/A") as { declared: number; observed_rows: number } | undefined

		expect(row).toBeDefined()
		expect(row!.declared).toBe(0)
		expect(row!.observed_rows).toBe(1)

		// And the reader reports it as undeclared on the reading itself, so a consumer sees the difference too.
		const unzonedCentre = {
			latitude: FIXTURE_ORIGIN.lat + FIXTURE_SIDE / 2,
			longitude: FIXTURE_ORIGIN.lon + 4.5 * FIXTURE_SIDE,
		}

		const reading = lookup.lookup(unzonedCentre.latitude, unzonedCentre.longitude)

		expect(reading.designations[0]!.crosswalk?.declared).toBe(false)
		// Its label is the code itself, because the row carried no description — never a label this package wrote for a
		// code the publisher never declared.
		expect(reading.designations[0]!.crosswalk?.label).toBe("N/A")
	})

	it("keeps a declared code the data never uses, at zero observed rows", () => {
		using database = new DatabaseClient<ZoningDatabase>(databasePath, { readOnly: true })

		// The domain is the publisher's statement of what a value MAY be, not a census of what it is. `SDZ` is the real
		// product's example: declared as a plan level and used on no row.
		const row = database
			.prepare("SELECT declared, observed_rows FROM zoning_vocabulary WHERE scheme = ? AND code = ?")
			.get("IE-PLAN-LEVEL", "SDZ") as { declared: number; observed_rows: number } | undefined

		expect(row).toBeDefined()
		expect(row!.declared).toBe(1)
		expect(row!.observed_rows).toBe(0)
	})

	it("scopes the local vocabulary to its own authority, because local codes collide across them", () => {
		using database = new DatabaseClient<ZoningDatabase>(databasePath, { readOnly: true })

		const schemes = (
			database.prepare("SELECT DISTINCT scheme FROM zoning_vocabulary ORDER BY scheme").all() as Array<{
				scheme: string
			}>
		).map((row) => row.scheme)

		expect(schemes).toContain("IE-LOCAL:Fx")
		expect(schemes).toContain("IE-GZT")
		expect(schemes).toContain("IE-SZO")
	})

	it("populates no definition URL, because the publisher's own points at a host with no DNS record", () => {
		using database = new DatabaseClient<ZoningDatabase>(databasePath, { readOnly: true })

		const withURL = database
			.prepare("SELECT count(*) AS n FROM zoning_vocabulary WHERE definition_url IS NOT NULL")
			.get() as { n: number }

		expect(withURL.n).toBe(0)
	})

	it("measures the crosswalk as NON-FUNCTIONAL over an (authority, code) pair", () => {
		// The same local code assigned two different generic types by the same authority — which is the whole argument for
		// carrying the local code verbatim and for the edge table being empty. Nationally: 52 of 795 pairs.
		expect(result.crosswalk.pairs).toBeGreaterThan(0)
		expect(result.crosswalk.nonFunctionalPairs).toBe(1)
		expect(result.crosswalk.worst[0]?.crosswalkCodes).toEqual(["R2", "R3"])
	})

	it("refuses to write a crosswalk edge table while any pair takes more than one generic type", () => {
		const pairs = nonFunctionalPairs([
			["CO", "Special Policy Area", ["C2.1", "M1", "R2"]],
			["Fx", "R2 - Existing Residential", ["R2"]],
		])

		expect(pairs).toHaveLength(1)

		expect(() =>
			assertCrosswalkIsNotATable(
				[
					["CO", "Special Policy Area", ["C2.1", "M1", "R2"]],
					["Fx", "R2 - Existing Residential", ["R2"]],
				],
				1
			)
		).toThrow(/take more than one generic type/u)

		// No edges, no refusal — the guard is about writing them, not about the mapping being a function.
		expect(() => assertCrosswalkIsNotATable([["CO", "Special Policy Area", ["C2.1", "M1"]]], 0)).not.toThrow()
	})
})

describe("the plan is part of the claim", () => {
	it("answers one coordinate with BOTH plans, each naming its own", () => {
		const reading = lookup.lookup(INSIDE_ZONE_A.latitude, INSIDE_ZONE_A.longitude)

		expect(reading.kind).toBe(ZoningReadingKind.Designated)
		expect(reading.designations).toHaveLength(2)

		expect(new Set(reading.designations.map((designation) => designation.plan.planID))).toEqual(
			new Set([FIXTURE_PLANS.development.id, FIXTURE_PLANS.localArea.id])
		)

		expect(new Set(reading.designations.map((designation) => designation.plan.level))).toEqual(new Set(["DP", "LAP"]))
	})

	it("carries the plan's own window, which is a different fact from its current-plan flag", () => {
		const reading = lookup.lookup(INSIDE_ZONE_A.latitude, INSIDE_ZONE_A.longitude)
		const designation = reading.designations[0]!

		// `currentPlan = 1` means NOT SUPERSEDED. Whether the window has closed is `validTo`, and the comparison against a
		// date is the caller's — 2,363 of the real product's 85,330 rows carry a `validTo` already in the past.
		expect(designation.plan.currentPlan).toBe(1)
		expect(designation.plan.validFrom).toBeTruthy()
		expect(designation.plan.validTo).toBeTruthy()
	})

	it("names the authority on every designation, with its own code carried unrepaired", () => {
		const reading = lookup.lookup(INSIDE_ZONE_A.latitude, INSIDE_ZONE_A.longitude)

		expect(reading.designations[0]!.jurisdiction.sourceCode).toBe("Fx")
		expect(reading.designations[0]!.jurisdiction.country).toBe("IE")
	})
})

describe("the meaning-of-zero rule", () => {
	it("reads a point outside every polygon as unknown, never as an absence designation", () => {
		const reading = lookup.lookup(OUTSIDE_EVERY_ZONE.latitude, OUTSIDE_EVERY_ZONE.longitude)

		expect(reading.kind).toBe(ZoningReadingKind.Unknown)
		expect(reading.designations).toEqual([])
		expect(reading.containment).toBe(ZoningContainmentPath.NoZoneCell)
		expect(reading.coverageLimit).toMatch(/records source presence only/u)
	})

	it("reports UNZONED as a positive value where the authority states it, which is what makes silence silence", () => {
		const unzonedCentre = {
			latitude: FIXTURE_ORIGIN.lat + FIXTURE_SIDE / 2,
			longitude: FIXTURE_ORIGIN.lon + 4.5 * FIXTURE_SIDE,
		}

		const reading = lookup.lookup(unzonedCentre.latitude, unzonedCentre.longitude)

		expect(reading.kind).toBe(ZoningReadingKind.Designated)
		expect(reading.designations[0]!.localCode).toBe(GZT_UNZONED_LOCAL_CODE)
		expect(reading.designations[0]!.unzoned).toBe(true)

		// And an ordinary designation is not unzoned, so the flag is a reading rather than a default.
		expect(lookup.lookup(INSIDE_ZONE_A.latitude, INSIDE_ZONE_A.longitude).designations[0]!.unzoned).toBe(false)
	})

	it("answers a point inside a hole as outside the polygon", () => {
		const holeCentre = {
			latitude: FIXTURE_ORIGIN.lat + 2.5 * FIXTURE_SIDE,
			longitude: FIXTURE_ORIGIN.lon + FIXTURE_SIDE / 2,
		}

		expect(lookup.lookup(holeCentre.latitude, holeCentre.longitude).kind).toBe(ZoningReadingKind.Unknown)

		// And the ground around the hole IS zoned, so the hole is a hole rather than the whole feature going missing.
		expect(lookup.lookup(FIXTURE_ORIGIN.lat + 2.1 * FIXTURE_SIDE, FIXTURE_ORIGIN.lon + FIXTURE_SIDE * 0.1).kind).toBe(
			ZoningReadingKind.Designated
		)
	})

	it("writes every coverage row on source_present, so none of them supports an exclusion", () => {
		using database = new DatabaseClient<ZoningDatabase>(databasePath, { readOnly: true })

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
		const path = scratch.resolve("tampered.db")

		// The sealed artifact is copied and one coverage row is promoted to `designated`, which is exactly what a builder
		// generalizing the flood layer's rule would have produced. The reader must refuse rather than answer confidently.
		using source = new DatabaseClient<ZoningDatabase>(databasePath, { readOnly: true })

		source.exec(`VACUUM INTO '${path}'`)

		using tampered = new DatabaseClient<ZoningDatabase>(path)

		// Keyed on `h3_cell` rather than on `rowid`, because `layer_coverage` is `WITHOUT ROWID` and has none.
		tampered.exec(
			`UPDATE layer_coverage SET basis = '${CoverageBasis.Designated}' ` +
				"WHERE h3_cell = (SELECT min(h3_cell) FROM layer_coverage)"
		)

		expect(() => new ZoningLookup({ databasePath: path })).toThrow(/supports an EXCLUSION/u)
	})
})

describe("the provenance grade", () => {
	it("stamps every row authoritative and rejects a blank at the storage layer", () => {
		using database = new DatabaseClient<ZoningDatabase>(databasePath, { readOnly: true })

		const grades = (
			database.prepare("SELECT DISTINCT provenance_grade FROM zoning_area").all() as Array<{
				provenance_grade: string
			}>
		).map((row) => row.provenance_grade)

		expect(grades).toEqual(["authoritative"])

		// The CHECK is what makes the grade a constraint rather than a convention. `NOT NULL` alone accepts `''`, and a
		// blank matches neither half of every read that splits on grade.
		const path = scratch.resolve("grade-check.db")
		using source = new DatabaseClient<ZoningDatabase>(databasePath, { readOnly: true })

		source.exec(`VACUUM INTO '${path}'`)

		using copy = new DatabaseClient<ZoningDatabase>(path)

		expect(() => copy.exec("UPDATE zoning_area SET provenance_grade = '' WHERE area_id = '1'")).toThrow(
			/CHECK constraint failed/u
		)

		expect(() => copy.exec("UPDATE zoning_area SET provenance_grade = 'observed' WHERE area_id = '1'")).toThrow(
			/CHECK constraint failed/u
		)

		// And the one grade this artifact does not hold is still a legal VALUE — the constraint is about the vocabulary,
		// and keeping the grades apart is the artifact's job rather than the column's.
		expect(() => copy.exec("UPDATE zoning_area SET provenance_grade = 'inferred' WHERE area_id = '1'")).not.toThrow()
	})

	it("rejects a blank local code at the storage layer too, because the local code is the claim", () => {
		const path = scratch.resolve("code-check.db")
		using source = new DatabaseClient<ZoningDatabase>(databasePath, { readOnly: true })

		source.exec(`VACUUM INTO '${path}'`)

		using copy = new DatabaseClient<ZoningDatabase>(path)

		expect(() => copy.exec("UPDATE zoning_area SET local_code = '  ' WHERE area_id = '1'")).toThrow(
			/CHECK constraint failed/u
		)
	})
})

describe("the area cross-check", () => {
	it("reports the hole-blind reading beside the nested one, and it is larger", () => {
		expect(result.area.allExteriorKM2).toBeGreaterThan(result.area.nestedKM2)
		// The signed sum IS the nested reading under this service's convention, which is the receipt that the orientation
		// was read rather than assumed.
		expect(result.area.signedKM2).toBeCloseTo(result.area.nestedKM2, 6)
	})

	it("leaves the publisher's figure ABSENT where it was not read, rather than defaulting it to its own", () => {
		// A receipt printing "publisher 205.4 km², 0.000% apart" for a check that never ran is the one shape a reader cannot
		// tell from a pass. The fixture build supplies no publisher figure, so the reading's witness is absent.
		expect(result.area.witness).toBe("absent")
	})

	it("refuses a build whose rings do not add up to the publisher's own area", async () => {
		const { lon, lat } = FIXTURE_ORIGIN

		const one = fixtureFeature(9, [[exteriorRing(lon, lat, lon + FIXTURE_SIDE, lat + FIXTURE_SIDE)]])

		// Twice the area the rings actually cover — the shape a hole read as an exterior ring produces.
		const doubled = 2 * one.rings.signedAreaM2

		await expect(
			buildZoningDatabase({
				source: fixtureSource([one]),
				out: scratch.resolve("bad-area.db"),
				sourceVintage: "2026-05-13",
				buildCmd: "vitest",
				buildSHA: "fixture",
				createdAt: "2026-08-28T00:00:00.000Z",
				indexResolution: INDEX_RESOLUTION,
				coverageResolution: COVERAGE_RESOLUTION,
				expectedSourceAreaM2: doubled,
			})
		).rejects.toThrow(/encoded rings total/u)
	})

	it("agrees with the publisher's figure when the rings carry their holes", async () => {
		const { lon, lat } = FIXTURE_ORIGIN

		const holed = fixtureFeature(10, [
			[exteriorRing(lon, lat, lon + FIXTURE_SIDE, lat + FIXTURE_SIDE)],
			[
				holeRing(
					lon + FIXTURE_SIDE * 0.3,
					lat + FIXTURE_SIDE * 0.3,
					lon + FIXTURE_SIDE * 0.7,
					lat + FIXTURE_SIDE * 0.7
				),
			],
		])

		const built = await buildZoningDatabase({
			source: fixtureSource([holed]),
			out: scratch.resolve("good-area.db"),
			sourceVintage: "2026-05-13",
			buildCmd: "vitest",
			buildSHA: "fixture",
			createdAt: "2026-08-28T00:00:00.000Z",
			indexResolution: INDEX_RESOLUTION,
			coverageResolution: COVERAGE_RESOLUTION,
			expectedSourceAreaM2: holed.rings.signedAreaM2,
		})

		if (built.area.witness !== "source")
			throw new Error("the publisher's figure was supplied, so the witness is the source")

		expect(built.area.relativeGap).toBeLessThan(0.0001)
		expect(built.rings.holes).toBe(1)
		expect(built.rings.nestedHoles).toBe(1)
	})
})

describe("the build-local posture", () => {
	it("refuses a shipped tier while the licence is unresolved", async () => {
		await expect(
			buildZoningDatabase({
				source: fixtureSource(fixtureFeatures()),
				out: scratch.resolve("shipped.db"),
				sourceVintage: "2026-05-13",
				buildCmd: "vitest",
				buildSHA: "fixture",
				createdAt: "2026-08-28T00:00:00.000Z",
				indexResolution: INDEX_RESOLUTION,
				coverageResolution: COVERAGE_RESOLUTION,
				tier: LayerTier.Shipped,
			})
		).rejects.toThrow(/Three published statements disagree/u)
	})

	it("refuses a coverage resolution finer than the index resolution", async () => {
		await expect(
			buildZoningDatabase({
				source: fixtureSource(fixtureFeatures()),
				out: scratch.resolve("bad-resolutions.db"),
				sourceVintage: "2026-05-13",
				buildCmd: "vitest",
				buildSHA: "fixture",
				createdAt: "2026-08-28T00:00:00.000Z",
				indexResolution: 6,
				coverageResolution: 10,
			})
		).rejects.toThrow(/must be coarser/u)
	})

	it("refuses a short read rather than building a smaller country", async () => {
		const features = fixtureFeatures()
		const source = fixtureSource(features)

		await expect(
			buildZoningDatabase({
				source: { ...source, declaredFeatureCount: features.length + 1 },
				out: scratch.resolve("short-read.db"),
				sourceVintage: "2026-05-13",
				buildCmd: "vitest",
				buildSHA: "fixture",
				createdAt: "2026-08-28T00:00:00.000Z",
				indexResolution: INDEX_RESOLUTION,
				coverageResolution: COVERAGE_RESOLUTION,
			})
		).rejects.toThrow(/a short read builds a smaller country/u)
	})
})
