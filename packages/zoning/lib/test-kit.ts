/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/zoning/test-kit` — hand-built geometry for the fixture rung: zones in two plans over the same ground, one with a hole encoded the way this service encodes them, one smaller than a cell, and one the authority states as unzoned.
 *
 *   Under this service a clockwise ring is the exterior and a counter-clockwise one is a hole, the inverse of the GeoJSON convention and of every sibling fixture.
 */

import {
	rectangleRing as counterClockwiseRing,
	reversedRing as clockwiseRing,
	type MultiPolygonRings,
} from "@mailwoman/spatial"

import { resolveRingRoles } from "#rings"
import type { ZoningFeatureSource, ZoningSourceFeature } from "#sdk/ingest/index"
import { GZT_SOURCE_EPSG, GZT_UNZONED_LOCAL_CODE } from "#vocabulary"

/**
 * The exterior ring builder under this service's convention.
 */
export const exteriorRing = clockwiseRing

/**
 * The hole ring builder under this service's convention.
 */
export const holeRing = counterClockwiseRing

/**
 * South-west corner of the fixture world, in the Irish Sea east of Dublin.
 */
export const FIXTURE_ORIGIN = { lon: -5.99, lat: 53.3 } as const

/**
 * Side of a fixture zone in degrees.
 */
export const FIXTURE_SIDE = 0.01

/**
 * The fixture authority's code and name.
 */
export const FIXTURE_AUTHORITY = { code: "Fx", name: "Fixture County Council" } as const

/**
 * The two plans the fixture set uses, shaped like the real product's, with dates carried as published in the source's own RFC 1123 form.
 */
export const FIXTURE_PLANS = {
	development: {
		id: "FX-DP-2024",
		name: "Fixture County Development Plan 2024-2030",
		level: "DP",
		from: "Mon, 01 Jan 2024 00:00:00 GMT",
		to: "Sun, 31 Dec 2030 00:00:00 GMT",
	},
	localArea: {
		id: "FX-LAP-2022",
		name: "Fixture Town Local Area Plan 2022-2028",
		level: "LAP",
		from: "Sat, 01 Jan 2022 00:00:00 GMT",
		to: "Sun, 31 Dec 2028 00:00:00 GMT",
	},
} as const

/**
 * One fixture feature, with its rings resolved the way the real ingest resolves them.
 */
export function fixtureFeature(
	objectID: number,
	polygons: MultiPolygonRings,
	overrides: Partial<Omit<ZoningSourceFeature, "rings">> = {}
): ZoningSourceFeature {
	const plan = FIXTURE_PLANS.development

	return {
		areaID: String(objectID),
		authorityCode: FIXTURE_AUTHORITY.code,
		authorityName: FIXTURE_AUTHORITY.name,
		planID: plan.id,
		planName: plan.name,
		planLevel: plan.level,
		planFrom: plan.from,
		planTo: plan.to,
		currentPlan: 1,
		localCode: "R2 - Existing Residential",
		localDescription: "Existing residential",
		localCodeURL: "https://example.invalid/fixture-plan",
		crosswalkCode: "R2",
		crosswalkDescription: "Existing residential",
		crosswalkRollup: "RE",
		...overrides,
		// Resolved through the real resolver rather than hand-assembled.
		rings: resolveRingRoles(polygons, String(objectID)),
	}
}

/**
 * The fixture set: two adjacent zones (one holed the way this service encodes holes), a second plan over the same ground, a zone smaller than a cell, and a zone the authority states as unzoned.
 */
export function fixtureFeatures(): ZoningSourceFeature[] {
	const { lon, lat } = FIXTURE_ORIGIN

	const zoneA = exteriorRing(lon, lat, lon + FIXTURE_SIDE, lat + FIXTURE_SIDE)
	const zoneB = exteriorRing(lon + FIXTURE_SIDE, lat, lon + 2 * FIXTURE_SIDE, lat + FIXTURE_SIDE)

	// The hole is a separate part rather than a nested ring, which is how the real service encodes it.
	const holed: MultiPolygonRings = [
		[exteriorRing(lon, lat + 2 * FIXTURE_SIDE, lon + FIXTURE_SIDE, lat + 3 * FIXTURE_SIDE)],
		[
			holeRing(
				lon + FIXTURE_SIDE * 0.35,
				lat + 2 * FIXTURE_SIDE + FIXTURE_SIDE * 0.35,
				lon + FIXTURE_SIDE * 0.65,
				lat + 2 * FIXTURE_SIDE + FIXTURE_SIDE * 0.65
			),
		],
	]

	// Smaller than a res-11 cell, so `polygonToCells` returns no cell and the index must cover it by cell-touches-polygon rather than centre-in-polygon.
	const sliver = exteriorRing(lon + 3 * FIXTURE_SIDE, lat, lon + 3 * FIXTURE_SIDE + 0.00005, lat + 0.00005)

	const unzoned = exteriorRing(lon + 4 * FIXTURE_SIDE, lat, lon + 5 * FIXTURE_SIDE, lat + FIXTURE_SIDE)

	const localAreaPlan = FIXTURE_PLANS.localArea

	return [
		fixtureFeature(1, [[zoneA]]),
		fixtureFeature(2, [[zoneB]], {
			localCode: "C2.1 - Industrial",
			localDescription: "Industrial, enterprise and employment",
			crosswalkCode: "C2.1",
			crosswalkDescription: "Industrial, enterprise, employment",
		}),
		fixtureFeature(3, holed, {
			localCode: "G1 - Open Space",
			localDescription: "Open space and park",
			crosswalkCode: "G1",
			crosswalkDescription: "Open space, park",
		}),
		fixtureFeature(4, [[sliver]], {
			localCode: "N1.1 - Road",
			localDescription: "Road reservation",
			crosswalkCode: "N1.1",
			crosswalkDescription: "Road",
		}),
		// The authority states unzoned land positively, and uses a code its own domain never declares for it.
		fixtureFeature(5, [[unzoned]], {
			localCode: GZT_UNZONED_LOCAL_CODE,
			localDescription: "Unzoned",
			crosswalkCode: "N/A",
			crosswalkDescription: null,
			crosswalkRollup: "N/A",
		}),
		// The same ground as zone A under a second plan, with the same local code mapped to a different generic type.
		fixtureFeature(6, [[zoneA]], {
			planID: localAreaPlan.id,
			planName: localAreaPlan.name,
			planLevel: localAreaPlan.level,
			planFrom: localAreaPlan.from,
			planTo: localAreaPlan.to,
			crosswalkCode: "R3",
			crosswalkDescription: "Residential, mixed residential and other uses",
		}),
	]
}

/**
 * A feature source over an explicit feature list.
 */
export function fixtureSource(features: ZoningSourceFeature[]): ZoningFeatureSource {
	return {
		declaredFeatureCount: features.length,
		epsg: GZT_SOURCE_EPSG,
		origin: "fixture",
		async *features() {
			yield* features
		},
	}
}
