/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The coverage footprint, and the one thing about it that is easy to get wrong in a way nothing reports.
 *
 *   THE INTERIOR TEST IS CONSERVATIVE, SO WHERE IT IS APPLIED DECIDES HOW MUCH OF A STATE ANSWERS.
 *   `interiorCoverageCells` keeps only cells lying WHOLLY inside a geometry — correct, because a cell
 *   wrongly called interior would state that an authority determined a location it never looked at. Applied
 *   PER SURVEY AREA it also drops every cell a county border crosses, and at resolution 6 those cells are
 *   about 6.5 km across against a county roughly 50 km across: measured on Polk County, 20 interior cells
 *   against the ~42 it spans by area. More than half the county would have read `unknown` while sitting
 *   inside a survey the build had ingested — an artifact that is complete, well-formed, and silently
 *   answers "no survey here" over ground it holds.
 *
 *   The fix is to run the test ONCE over the union. This file pins it with two adjacent fixture areas that
 *   share an edge, because the per-area version passes every other test in this package.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import type { LayerContractDatabase } from "@mailwoman/core/layers/schema"
import { SoilCapabilityLookup, SoilReadingKind } from "@mailwoman/soil"
import { buildSoilDatabase, type SurveyAreaInput } from "@mailwoman/soil/sdk/build-soil"
import type { SoilDelineation } from "@mailwoman/soil/sdk/ingest"
import {
	FIXTURE_ORIGIN,
	FIXTURE_SIDE,
	fixtureAttributes,
	fixtureDelineations,
	fixtureSource,
	rectangleRing,
} from "@mailwoman/soil/test-kit"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { join } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

const { lat, lon } = FIXTURE_ORIGIN

/**
 * Half the width of each fixture county, in degrees. Wide enough that resolution-6 cells fit wholly inside one, so a
 * per-area build is not vacuously empty — it produces cells, just not the ones on the shared edge.
 */
const COUNTY_HALF_WIDTH = 0.9

/**
 * The shared edge the two fixture counties tile along. Cells straddling it are interior to the union and to neither
 * county on its own.
 */
const SHARED_EDGE_LON = lon + 5 * FIXTURE_SIDE

/**
 * How far the second delineation band sits from the shared edge — comfortably more than a resolution-6 cell's ~0.06°,
 * so a county's own interior test produces coverage over it whether or not the border cells survive.
 *
 * Both bands are needed. Without the interior band a single county yields NO coverage rows at all (its mapped soil sits
 * entirely inside the strip its own interior test drops), and the comparison below would be against zero.
 */
const INTERIOR_BAND_OFFSET = 0.3

/**
 * One band of the fixture delineations, shifted east by `offset` and re-keyed so two bands never collide.
 */
function shiftedBand(areaSymbol: string, offset: number, band: number): SoilDelineation[] {
	return fixtureDelineations(areaSymbol).map((delineation, index) => ({
		...delineation,
		areaID: `${areaSymbol}:${band * 10 + index}`,
		polygons: delineation.polygons.map((rings) => rings.map((ring) => shiftRing(ring, offset))),
	}))
}

function shiftRing(ring: ReadonlyArray<readonly number[]>, offset: number): number[][] {
	return ring.map((position) => [position[0]! + offset, position[1]!])
}

function county(areaSymbol: string, minLon: number, maxLon: number, offsets: readonly number[]): SurveyAreaInput {
	const delineations = offsets.flatMap((offset, band) => shiftedBand(areaSymbol, offset, band))

	return {
		attributes: fixtureAttributes(areaSymbol),
		outline: {
			type: "Polygon",
			coordinates: [rectangleRing(minLon, lat - COUNTY_HALF_WIDTH, maxLon, lat + COUNTY_HALF_WIDTH)],
		},
		source: fixtureSource(delineations, areaSymbol),
		declaredFeatureCount: delineations.length,
	}
}

/**
 * The west county: mapped soil up against the shared edge, and a second band well inside it.
 */
function westCounty(): SurveyAreaInput {
	return county("XX001", SHARED_EDGE_LON - 2 * COUNTY_HALF_WIDTH, SHARED_EDGE_LON, [0, -INTERIOR_BAND_OFFSET])
}

/**
 * The east county, mirrored across the shared edge.
 */
function eastCounty(): SurveyAreaInput {
	return county("XX002", SHARED_EDGE_LON, SHARED_EDGE_LON + 2 * COUNTY_HALF_WIDTH, [
		5 * FIXTURE_SIDE,
		INTERIOR_BAND_OFFSET,
	])
}

async function build(areas: SurveyAreaInput[]): Promise<string> {
	const scratch = fixtures.use(await temporaryDirectory("mw-soil-coverage-")).path

	const databasePath = join(scratch, "soil.db")

	await buildSoilDatabase({
		areas,
		region: "xx",
		out: databasePath,
		sourceVintage: "2025-09-09",
		buildCmd: "vitest",
		buildSHA: "fixture",
		createdAt: "2026-08-28T00:00:00.000Z",
		indexResolution: 9,
		coverageResolution: 6,
		inProcess: true,
	})

	return databasePath
}

function coverageCellCount(databasePath: string): number {
	using database = new DatabaseClient<LayerContractDatabase>(databasePath, { readOnly: true })

	return (database.prepare("SELECT count(*) AS n FROM layer_coverage").get() as { n: number }).n
}

describe("the coverage footprint over adjacent survey areas", () => {
	it("covers the shared border, which a per-area interior test drops", async () => {
		// Two counties tiling along `SHARED_EDGE_LON`, each carrying a band of delineations up against that edge, so the
		// cells straddling it are genuinely reached by mapped soil from both sides.
		const [westOnly, eastOnly, both] = await Promise.all([
			build([westCounty()]).then(coverageCellCount),
			build([eastCounty()]).then(coverageCellCount),
			build([westCounty(), eastCounty()]).then(coverageCellCount),
		])

		expect(westOnly).toBeGreaterThan(0)
		expect(eastOnly).toBeGreaterThan(0)

		// STRICTLY greater than the sum, and the excess IS the border strip: those cells lie wholly inside the union and
		// wholly inside neither county, so a per-area test cannot produce them however many areas it is given.
		expect(both).toBeGreaterThan(westOnly + eastOnly)
	})

	it("still refuses to claim ground beyond the outer edge of everything built", async () => {
		const databasePath = await build([westCounty()])
		const lookup = new SoilCapabilityLookup({ databasePath })

		try {
			// Well outside the single county built. The conservatism the union fix preserves: beyond the built set there is
			// no coverage row, and that is the truthful answer rather than a low capability reading.
			const reading = lookup.lookup(lat + 5, lon + 5)

			expect(reading.kind).toBe(SoilReadingKind.Unknown)
			expect(reading.coverage).toBeUndefined()
		} finally {
			lookup[Symbol.dispose]()
		}
	})
})
