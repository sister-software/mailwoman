/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import type { layerschemadatabase } from "@mailwoman/core/layers/schema"
import { rectangleRing } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilder } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

import { SoilCapabilityLookup, SoilReadingKind } from "#index"
import { buildSoilDatabase, type SurveyAreaInput } from "#sdk/build-soil"
import type { SoilDelineation } from "#sdk/ingest/index"
import { FIXTURE_ORIGIN, FIXTURE_SIDE, fixtureAttributes, fixtureDelineations, fixtureSource } from "#test-kit"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

const { lat, lon } = FIXTURE_ORIGIN

/**
 * Half the width of each fixture county, wide enough that resolution-6 cells fit
 * wholly inside one, so a per-area build is not vacuously empty.
 */
const COUNTY_HALF_WIDTH = 0.9

/**
 * The shared edge the two fixture counties tile along.
 *
 * Cells straddling it are interior to the union and to neither county by itself.
 */
const SHARED_EDGE_LON = lon + 5 * FIXTURE_SIDE

/**
 * How far the second delineation band sits from the shared edge, beyond a resolution-6
 * cell's ~0.06°, so a single county still yields coverage rather than zero.
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
 * The west county has mapped soil at the shared edge and a second band well inside it.
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

async function build(areas: SurveyAreaInput[]): Promise<PathBuilder> {
	const scratch = fixtures.use(await temporaryDirectory("mw-soil-coverage-")).path

	const databasePath = scratch("soil.db")

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

function coverageCellCount(databasePath: PathBuilder): number {
	using database = new DatabaseClient<layerschemadatabase>(databasePath, { readOnly: true })

	return (database.prepare("SELECT count(*) AS n FROM layer_coverage").get() as { n: number }).n
}

describe("the coverage footprint over adjacent survey areas", () => {
	it("covers the shared border, which a per-area interior test drops", async () => {
		// Two counties tile along `SHARED_EDGE_LON`, each carrying a band of delineations
		// against that edge, so the cells straddling it are reached from both sides.
		const [westOnly, eastOnly, both] = await Promise.all([
			build([westCounty()]).then(coverageCellCount),
			build([eastCounty()]).then(coverageCellCount),
			build([westCounty(), eastCounty()]).then(coverageCellCount),
		])

		expect(westOnly).toBeGreaterThan(0)
		expect(eastOnly).toBeGreaterThan(0)

		// The excess is the border strip: cells inside the union but outside either county individually.
		// A per-area test cannot produce these cells, regardless of the number of areas.
		expect(both).toBeGreaterThan(westOnly + eastOnly)
	})

	it("still refuses to claim ground beyond the outer edge of everything built", async () => {
		const databasePath = await build([westCounty()])
		const lookup = new SoilCapabilityLookup({ databasePath })

		try {
			// Well outside the single county built, where there is no coverage row —
			// the truthful answer rather than a low capability reading.
			const reading = lookup.lookup(lat + 5, lon + 5)

			expect(reading.kind).toBe(SoilReadingKind.Unknown)
			expect(reading.coverage).toBeUndefined()
		} finally {
			lookup[Symbol.dispose]()
		}
	})
})
