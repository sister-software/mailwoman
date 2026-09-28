/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/flood/test-kit` provides hand-built geometry for fixtures. It includes a square zone polygon,
 *   It includes a square zone polygon plus a polygon in an adjacent zone. Another polygon has a hole.
 *   A mapped-extent rectangle exceeds the cells the polygons reach.
 *
 *   This module uses a package subpath rather than a `test/` file, like `packages/mailwoman/lib/test-kit`.
 *   The observation route's suite lives in another workspace. TypeScript rejects a relative import across projects
 *   with `TS2878` because the compiled layout does not match the source layout.
 *
 *   The fixture uses no network or GDAL. The builder accepts a {@linkcode FloodFeatureSource}, so fixtures can supply
 *   feature lists. This lets every machine exercise the vocabulary checks and cell classification.
 *   It also exercises coverage rows and manifest generation. It exercises sealing without `ogr2ogr`.
 *
 *   The coordinates deliberately fall over England. The extent rectangle sits in the North Sea off Great Yarmouth,
 *   where no real EA polygon interferes. It remains inside the declared ingest extent and uses the product's coordinate space.
 */

// The exterior and hole ring builders live in `@mailwoman/spatial`.
// Ring winding is a geometry convention owned by `@mailwoman/spatial`.
// Reimplementing it here would create another place for a hole to be lost.
import { rectangleRing, reversedRing as holeRing, ringAreaReadings, type MultiPolygonRings } from "@mailwoman/spatial"

import type { FloodFeatureSource, FloodSourceFeature } from "#sdk/ingest/index"
import { EA_FLOOD_LAYER, EA_SOURCE_EPSG } from "#vocabulary"

/**
 * Re-exported so a fixture in another workspace builds its rings the same way this one does.
 */

/**
 * South-west corner of the fixture world, in the North Sea east of Great Yarmouth.
 */
export const FIXTURE_ORIGIN = { lon: 1.9, lat: 52.6 } as const

/**
 * Side of a fixture zone square, in degrees.
 *
 * About 1.1 km at this latitude — several res-9 cells across, so a square has
 * a real interior and a real fringe.
 */
export const FIXTURE_SIDE = 0.01

/**
 * One fixture feature, with its area computed from its own rings so the build's
 * area cross-check has something true to compare against.
 */
export function fixtureFeature(
	areaID: string,
	zoneCode: string,
	polygons: MultiPolygonRings,
	overrides: Partial<FloodSourceFeature> = {}
): FloodSourceFeature {
	return {
		areaID,
		zoneCode,
		zoneSource: "river",
		origin: "modelled",
		// The real source's figure comes from gdal.
		// A fixture's comes from the same ring maths the build checks against,
		// so the fixture exercises the comparison rather than the tolerance.
		sourceAreaM2: ringAreaReadings(polygons).nested,
		polygons,
		...overrides,
	}
}

/**
 * Returns two adjacent squares in different zones plus a third square with a hole.
 */
export function fixtureFeatures(): FloodSourceFeature[] {
	const { lon, lat } = FIXTURE_ORIGIN

	const zone3 = rectangleRing(lon, lat, lon + FIXTURE_SIDE, lat + FIXTURE_SIDE)
	const zone2 = rectangleRing(lon + FIXTURE_SIDE, lat, lon + 2 * FIXTURE_SIDE, lat + FIXTURE_SIDE)

	const holed: MultiPolygonRings = [
		[
			rectangleRing(lon, lat + 2 * FIXTURE_SIDE, lon + FIXTURE_SIDE, lat + 3 * FIXTURE_SIDE),
			holeRing(
				lon + FIXTURE_SIDE * 0.35,
				lat + 2 * FIXTURE_SIDE + FIXTURE_SIDE * 0.35,
				lon + FIXTURE_SIDE * 0.65,
				lat + 2 * FIXTURE_SIDE + FIXTURE_SIDE * 0.65
			),
		],
	]

	return [
		fixtureFeature("1", "FZ3", [[zone3]]),
		fixtureFeature("2", "FZ2", [[zone2]]),
		fixtureFeature("3", "FZ3", holed),
	]
}

/**
 * The fixture extent outline.
 *
 * A rectangle comfortably larger than every fixture polygon, so its interior cells exist
 * at the coverage resolution and its border strip is well away from the zone geometry.
 */
export function fixtureExtentGeometry(): { type: "Polygon"; coordinates: number[][][] } {
	const { lon, lat } = FIXTURE_ORIGIN

	return {
		type: "Polygon",
		coordinates: [rectangleRing(lon - 0.5, lat - 0.5, lon + 0.5, lat + 0.5)],
	}
}

/**
 * A feature source over an explicit feature list.
 */
export function fixtureSource(features: FloodSourceFeature[]): FloodFeatureSource {
	return {
		declaredFeatureCount: features.length,
		layer: EA_FLOOD_LAYER,
		epsg: EA_SOURCE_EPSG,
		origin: "fixture",
		async *features() {
			yield* features
		},
	}
}
