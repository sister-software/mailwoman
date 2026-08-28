/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/coastal/test-kit` — hand-built geometry for the fixture rung: erosion bands in two scenarios,
 *   one with a hole, one narrower than a cell, plus a ground-instability polygon that must never answer an
 *   erosion question.
 *
 *   A PACKAGE SUBPATH RATHER THAN A `test/` FILE, for the same reason `packages/mailwoman/test-kit` is one:
 *   the observation route's suite lives in another workspace, and a relative import across two TypeScript
 *   projects is refused outright (`TS2878`) because the compiled layout would not match the source layout.
 *
 *   NO NETWORK AND NO GDAL. The builder takes a {@linkcode CoastalFeatureSource}, so a fixture is a list of
 *   features — which is what lets this rung exercise the domain checks, the cell classification, the coverage
 *   rows, the manifest and the seal on every machine rather than only the ones with ogr2ogr.
 *
 *   THE COORDINATES ARE OFF THE ENGLISH COAST, and deliberately so. The bands sit in the North Sea east of
 *   Great Yarmouth where no real NCERM polygon interferes, but inside the extent the ingest asserts against —
 *   so a fixture stays a fixture and still lives in the coordinate space the product occupies.
 *
 *   THE SAME FRONTAGE ID IS REUSED ON PURPOSE. The real product repeats a frontage id within one layer —
 *   `NCERM_NFI_2055_0CC` holds 7,379 features over 7,369 distinct frontage ids — so the fixture repeats one
 *   too, and a build keyed on the frontage rather than on the authority's feature id fails here rather than in
 *   production.
 */

// The exterior and hole ring builders live in `@mailwoman/spatial` — a winding convention rather than this
// product's geometry, and a second copy of it is a second place for a hole to stop being one.
import { rectangleRing, reversedRing as holeRing } from "@mailwoman/spatial"

import { ringAreaReadings } from "./rings.ts"
import type {
	CoastalFeatureSource,
	CoastalInstabilityFeature,
	CoastalSourceFeature,
	MultiPolygonRings,
} from "./sdk/ingest.ts"
import { NCERM_SCENARIOS_BY_KEY, NCERM_SOURCE_EPSG, type CoastalScenario } from "./vocabulary.ts"

/**
 * Re-exported so a fixture in another workspace builds its rings the same way this one does.
 */
export { rectangleRing, reversedRing as holeRing } from "@mailwoman/spatial"

/**
 * South-west corner of the fixture world, in the North Sea east of Great Yarmouth.
 */
export const FIXTURE_ORIGIN = { lon: 1.9, lat: 52.6 } as const

/**
 * Side of a fixture erosion band, in degrees. About 1.1 km at this latitude — several res-9 cells across, so a band has
 * a real interior AND a real fringe.
 */
export const FIXTURE_SIDE = 0.01

/**
 * The two scenarios the fixture set uses: one with no shoreline-management policy, one with.
 */
export const FIXTURE_SCENARIOS = {
	noIntervention: NCERM_SCENARIOS_BY_KEY.get("NFI_2055_0CC")!,
	withPlan: NCERM_SCENARIOS_BY_KEY.get("SMP_2105_95CC")!,
} as const

/**
 * One fixture erosion feature, with its area computed from its own rings so the build's area cross-check has something
 * true to compare against.
 */
export function fixtureFeature(
	objectID: number,
	scenario: CoastalScenario,
	polygons: MultiPolygonRings,
	overrides: Partial<CoastalSourceFeature> = {}
): CoastalSourceFeature {
	const carriesPolicy = scenario.management === "SMP"

	return {
		areaID: `${scenario.key}:${objectID}`,
		scenario,
		frontageID: 1000,
		distanceM: 42,
		smpNo: 6,
		smpName: "Fixture Shoreline Management Plan",
		smpPolicyUnit: "PU1.1",
		mtPolicy: carriesPolicy ? "Hold The Line" : null,
		mtPolicyInterpretation: carriesPolicy ? "Erosion restricted" : null,
		ltPolicy: carriesPolicy ? "No Active Intervention" : null,
		ltPolicyInterpretation: carriesPolicy ? "Erosion unrestricted" : null,
		defenceType: "Vertical Wall - Concrete",
		publishedYear: 2024,
		maxOverlap: 0,
		// The real source's figure comes from GDAL; a fixture's comes from the same ring maths the build checks against,
		// so the fixture exercises the comparison rather than the tolerance.
		sourceAreaM2: ringAreaReadings(polygons).nested,
		polygons,
		...overrides,
	}
}

/**
 * The fixture erosion set: two adjacent bands in the no-intervention scenario (one of them holed), one band in the
 * with-plan scenario covering the SAME ground as the first, and one band narrower than a res-9 cell.
 *
 * THE OVERLAP BETWEEN SCENARIOS IS THE POINT. A point inside the first band must answer under both scenarios with
 * DIFFERENT distances, which is what proves the twelve layers stay separable rather than pooled.
 */
export function fixtureFeatures(): CoastalSourceFeature[] {
	const { lon, lat } = FIXTURE_ORIGIN
	const nfi = FIXTURE_SCENARIOS.noIntervention
	const smp = FIXTURE_SCENARIOS.withPlan

	const bandA = rectangleRing(lon, lat, lon + FIXTURE_SIDE, lat + FIXTURE_SIDE)
	const bandB = rectangleRing(lon + FIXTURE_SIDE, lat, lon + 2 * FIXTURE_SIDE, lat + FIXTURE_SIDE)

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

	// About 5.5 m across — narrower than a res-11 cell, let alone a res-9 one. `polygonToCells` returns nothing for a
	// shape this size, so it is the fixture that proves the index takes cell-touches-polygon rather than centre-in-polygon.
	const sliver = rectangleRing(lon + 3 * FIXTURE_SIDE, lat, lon + 3 * FIXTURE_SIDE + 0.00005, lat + 0.00005)

	return [
		fixtureFeature(1, nfi, [[bandA]], { distanceM: 12 }),
		fixtureFeature(2, nfi, [[bandB]], { distanceM: 25, frontageID: 1000 }),
		fixtureFeature(3, nfi, holed, { distanceM: 40 }),
		fixtureFeature(4, nfi, [[sliver]], { distanceM: 3 }),
		// Same ground as band A, different scenario, much larger distance — a 2105 projection over a present-day band.
		fixtureFeature(1, smp, [[bandA]], { distanceM: 310 }),
	]
}

/**
 * One fixture ground-instability feature, well away from the erosion bands.
 */
export function fixtureInstabilityFeatures(): CoastalInstabilityFeature[] {
	const { lon, lat } = FIXTURE_ORIGIN

	const polygons: MultiPolygonRings = [
		[rectangleRing(lon + 5 * FIXTURE_SIDE, lat, lon + 6 * FIXTURE_SIDE, lat + FIXTURE_SIDE)],
	]

	return [
		{
			areaID: "zone:1",
			kind: "zone",
			location: "Fixture Cliff",
			localAuthority: "Fixture District",
			smpNo: 6,
			smpName: "Fixture Shoreline Management Plan",
			smpPolicyUnits: "PU1.1, PU1.2",
			rearScarpProbability: "50",
			sourceAreaM2: ringAreaReadings(polygons).nested,
			polygons,
		},
	]
}

/**
 * A feature source over explicit feature lists.
 */
export function fixtureSource(
	erosion: CoastalSourceFeature[],
	instability: CoastalInstabilityFeature[] = fixtureInstabilityFeatures()
): CoastalFeatureSource {
	const scenarios = [...new Set(erosion.map((feature) => feature.scenario.key))].map((key) =>
		NCERM_SCENARIOS_BY_KEY.get(key)!
	)

	return {
		declaredFeatureCount: erosion.length + instability.length,
		epsg: NCERM_SOURCE_EPSG,
		origin: "fixture",
		scenarios,
		async *erosionFeatures() {
			yield* erosion
		},
		async *instabilityFeatures() {
			yield* instability
		},
	}
}
