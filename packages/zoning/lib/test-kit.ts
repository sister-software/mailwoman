/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/zoning/test-kit` — hand-built geometry for the fixture rung: zones in two plans over the same
 *   ground, one with a hole encoded the way this service encodes them, one smaller than a cell, and one the
 *   authority states as unzoned.
 *
 *   A package subpath rather than A `test/` file, for the same reason `packages/mailwoman/lib/test-kit` is one:
 *   the observation route's suite lives in another workspace, and a relative import across two TypeScript
 *   projects is refused outright (`TS2878`) because the compiled layout would not match the source layout.
 *
 *   no network and no gdal. The builder takes a {@linkcode ZoningFeatureSource}, so a fixture is a list of
 *   features — which is what lets this rung exercise the ring-role resolution, the vocabulary census, the cell
 *   classification, the coverage rows, the manifest and the seal on every machine rather than only the ones
 *   with ogr2ogr.
 *
 *   the exterior ring is the clockwise one, which is the inverse OF the geojson convention and OF every
 *   sibling fixture. `@mailwoman/spatial`'s `rectangleRing` winds counter-clockwise and its `reversedRing`
 *   clockwise, so this file aliases them the other way round from the flood and coastal test kits: under this
 *   service a clockwise ring is the exterior and a counter-clockwise one is a hole. A fixture that used the
 *   sibling naming would build geometry the ingest reads inside-out, and every assertion on it would pass.
 *
 *   the coordinates are IN the irish SEA east of Dublin — inside the Department's declared extent, so a
 *   fixture stays in the coordinate space the product occupies, and clear of every real zoning polygon.
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
 * The exterior ring builder, under this service's convention.
 *
 * Clockwise.
 */
export const exteriorRing = clockwiseRing

/**
 * The hole ring builder, under this service's convention.
 *
 * Counter-clockwise.
 */
export const holeRing = counterClockwiseRing

/**
 * South-west corner of the fixture world, in the Irish Sea east of Dublin.
 */
export const FIXTURE_ORIGIN = { lon: -5.99, lat: 53.3 } as const

/**
 * Side of a fixture zone, in degrees.
 *
 * About 1.1 km at this latitude — several res-10 cells across, so a zone has
 * a real interior and a real fringe.
 */
export const FIXTURE_SIDE = 0.01

/**
 * The fixture authority and its two plans.
 */
export const FIXTURE_AUTHORITY = { code: "Fx", name: "Fixture County Council" } as const

/**
 * The two plans the fixture set uses, shaped like the real product's: a Development Plan
 * and a Local Area Plan, each with its own stated window, both able to zone the same ground.
 *
 * The dates are in the source's own RFC 1123 form, because that is what the export publishes
 * and this layer carries them as published rather than re-formatting them.
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
		// resolved through the real resolver, never hand-assembled: a fixture that
		// nested its own holes would test the assertion rather than the resolution,
		// and the resolution is the part of this layer no sibling already has.
		rings: resolveRingRoles(polygons, String(objectID)),
	}
}

/**
 * The fixture set: two adjacent zones, one of them holed the way this service encodes holes.
 *
 * A second plan over the same ground as the first.
 * A zone smaller than a cell.
 * And a zone the authority states as unzoned.
 *
 * The overlap between plans is the point.
 * A point inside the first zone must answer with both rows, each naming its own plan —
 * which is what proves a plan is part of the claim rather than a parameter of it.
 */
export function fixtureFeatures(): ZoningSourceFeature[] {
	const { lon, lat } = FIXTURE_ORIGIN

	const zoneA = exteriorRing(lon, lat, lon + FIXTURE_SIDE, lat + FIXTURE_SIDE)
	const zoneB = exteriorRing(lon + FIXTURE_SIDE, lat, lon + 2 * FIXTURE_SIDE, lat + FIXTURE_SIDE)

	// the hole is A separate part rather than a nested ring — which is how the
	// real service encodes it on the features that carry one, and the encoding a
	// nesting-aware reader turns into a second zoned area.
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

	// About 5.5 m across — smaller than a res-11 cell, let alone a res-9 one.
	// `polygonToCells` returns nothing for a shape this size, so it is the fixture that
	// proves the index takes cell-touches-polygon rather than centre-in-polygon.
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
		// The same ground as zone A under a second plan, and the same local code mapped to a different generic type — which is the shape that makes the crosswalk non-functional over an (authority, code) pair.
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
