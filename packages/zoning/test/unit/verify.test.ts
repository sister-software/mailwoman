/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two-path comparison's own logic, against a scripted service reader.
 *
 *   THE VALUE OF THE CHECK IS WHICH OF THREE OUTCOMES A POINT GETS, and that decision is what a live run can
 *   only be watched making. Expressed against a function rather than an HTTP client it can be pinned: a point
 *   the service also places inside AGREES, a point far from any service edge DISAGREES, and a point a few
 *   centimetres from an edge is `boundary_tolerance` — because the two channels render the same edge through
 *   different rounding.
 *
 *   AND THE SERVICE SIDE RESOLVES HOLE ROLES THE SAME WAY THE INGEST DOES. The publisher uses one convention
 *   on both channels, so a checker that read the service's rings as nested GeoJSON would answer "inside" for a
 *   point in a hole and report the artifact as wrong at exactly the locations the hole handling exists for.
 *
 *   THE NEGATIVE HALF IS PINNED HERE TOO. Donegal is the one local authority of 31 the Department does not
 *   publish, and Northern Ireland is a different jurisdiction entirely; both must read `unknown` with no
 *   designation, and this is the check that would catch a builder generalizing the flood layer's
 *   Zone-1-by-absence rule.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildZoningDatabase } from "@mailwoman/zoning/sdk/build-zoning"
import {
	OUTSIDE_PUBLICATION_POINTS,
	sampleAgreementPoints,
	verifyZoningDatabase,
	type ServiceFeature,
	type ServiceFeatureReader,
} from "@mailwoman/zoning/sdk/verify"
import {
	exteriorRing,
	fixtureFeatures,
	fixtureSource,
	FIXTURE_ORIGIN,
	FIXTURE_SIDE,
	holeRing,
} from "@mailwoman/zoning/test-kit"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

let scratch: string
let databasePath: string

/**
 * The service's rendering of the first fixture zone, in the publisher's own ring convention: a clockwise exterior.
 */
function zoneFeature(): ServiceFeature {
	const { lon, lat } = FIXTURE_ORIGIN

	return {
		properties: { OBJECTID: 1, ZONE_ORIG: "R2 - Existing Residential", ZONE_GZT: "R2", LA_CODE: "Fx" },
		geometry: { type: "Polygon", coordinates: [exteriorRing(lon, lat, lon + FIXTURE_SIDE, lat + FIXTURE_SIDE)] },
	}
}

/**
 * The same zone with a hole, published the way this service publishes one — each ring its own part.
 */
function holedZoneFeature(): ServiceFeature {
	const { lon, lat } = FIXTURE_ORIGIN

	return {
		properties: { OBJECTID: 3, ZONE_ORIG: "G1 - Open Space", ZONE_GZT: "G1", LA_CODE: "Fx" },
		geometry: {
			type: "MultiPolygon",
			coordinates: [
				[exteriorRing(lon, lat, lon + FIXTURE_SIDE, lat + FIXTURE_SIDE)],
				[
					holeRing(
						lon + FIXTURE_SIDE * 0.3,
						lat + FIXTURE_SIDE * 0.3,
						lon + FIXTURE_SIDE * 0.7,
						lat + FIXTURE_SIDE * 0.7
					),
				],
			],
		},
	}
}

const alwaysZone: ServiceFeatureReader = async () => [zoneFeature()]
const alwaysHoledZone: ServiceFeatureReader = async () => [holedZoneFeature()]
const alwaysEmpty: ServiceFeatureReader = async () => []

beforeAll(async () => {
	scratch = mkdtempSync(join(tmpdir(), "mw-zoning-verify-"))
	databasePath = join(scratch, "zoning-ireland.db")

	await buildZoningDatabase({
		source: fixtureSource(fixtureFeatures()),
		out: databasePath,
		sourceVintage: "2026-05-13",
		buildCmd: "vitest",
		buildSHA: "fixture",
		createdAt: "2026-08-28T00:00:00.000Z",
		indexResolution: 10,
		coverageResolution: 6,
	})
}, 120_000)

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true })
})

const INSIDE_ZONE_A = {
	label: "inside zone A",
	latitude: FIXTURE_ORIGIN.lat + FIXTURE_SIDE / 2,
	longitude: FIXTURE_ORIGIN.lon + FIXTURE_SIDE / 2,
}

describe("the positive half", () => {
	it("agrees where both paths place the point inside", async () => {
		const verified = await verifyZoningDatabase({
			databasePath,
			readServiceFeatures: alwaysZone,
			points: [INSIDE_ZONE_A],
		})

		expect(verified.agreed).toBe(1)
		expect(verified.disagreed).toBe(0)
		expect(verified.agreement[0]!.serviceLocalCode).toBe("R2 - Existing Residential")
		expect(verified.codeMismatches).toBe(0)
	})

	it("disagrees where the service publishes nothing and the artifact answers designated", async () => {
		const verified = await verifyZoningDatabase({
			databasePath,
			readServiceFeatures: alwaysEmpty,
			points: [INSIDE_ZONE_A],
		})

		expect(verified.disagreed).toBe(1)
		// No polygon nearby at all, so there is no edge to measure to — reported as absent rather than as zero.
		expect(verified.agreement[0]!.nearestEdgeMetres).toBeUndefined()
	})

	it("tolerates a point a few centimetres outside the service's rendering of the same edge", async () => {
		// The service's rendering of zone A's southern edge sits 0.000004° — about 45 cm — north of the artifact's, which is
		// the scale of a rounding difference between two renderings of the same coordinates.
		const shifted: ServiceFeatureReader = async () => [
			{
				geometry: {
					type: "Polygon",
					coordinates: [
						exteriorRing(
							FIXTURE_ORIGIN.lon,
							FIXTURE_ORIGIN.lat + 0.000004,
							FIXTURE_ORIGIN.lon + FIXTURE_SIDE,
							FIXTURE_ORIGIN.lat + FIXTURE_SIDE
						),
					],
				},
			},
		]

		// Inside the artifact's polygon and about 22 cm south of the service's edge — between the two renderings.
		const justInside = {
			label: "on zone A's southern edge",
			latitude: FIXTURE_ORIGIN.lat + 0.000002,
			longitude: FIXTURE_ORIGIN.lon + FIXTURE_SIDE / 2,
		}

		const verified = await verifyZoningDatabase({
			databasePath,
			readServiceFeatures: shifted,
			points: [justInside],
		})

		expect(verified.agreement[0]!.outcome).toBe("boundary_tolerance")
		expect(verified.agreement[0]!.nearestEdgeMetres).toBeLessThan(0.5)
	})

	it("reads the service's own hole the way the ingest reads it, so a point inside one is OUTSIDE on both paths", async () => {
		const holeCentre = {
			label: "inside the hole",
			latitude: FIXTURE_ORIGIN.lat + FIXTURE_SIDE / 2,
			longitude: FIXTURE_ORIGIN.lon + FIXTURE_SIDE / 2,
		}

		const verified = await verifyZoningDatabase({
			databasePath,
			readServiceFeatures: alwaysHoledZone,
			points: [holeCentre],
		})

		// A checker that read the service's two single-ring parts as two exteriors would report `inside` here, and the
		// artifact — which resolves the roles — would read as wrong.
		expect(verified.agreement[0]!.serviceInside).toBe(false)
	})
})

describe("the negative half", () => {
	it("reads every point outside the publication as unknown with no designation", async () => {
		const verified = await verifyZoningDatabase({
			databasePath,
			readServiceFeatures: alwaysEmpty,
			points: [],
		})

		expect(verified.outside).toHaveLength(OUTSIDE_PUBLICATION_POINTS.length)
		expect(verified.outsidePassed).toBe(OUTSIDE_PUBLICATION_POINTS.length)

		for (const row of verified.outside) {
			expect(row.kind).toBe("unknown")
			expect(row.designations).toBe(0)
		}
	})

	it("names a place for every point, because a coordinate a reader cannot name is one nobody can check", () => {
		for (const point of OUTSIDE_PUBLICATION_POINTS) {
			expect(point.label.length).toBeGreaterThan(0)
		}

		// Both populations are load-bearing: the unpublished authority, and the other jurisdiction.
		expect(OUTSIDE_PUBLICATION_POINTS.some((point) => point.label.includes("Donegal"))).toBe(true)
		expect(OUTSIDE_PUBLICATION_POINTS.some((point) => point.label.includes("Northern Ireland"))).toBe(true)
	})
})

describe("sampleAgreementPoints", () => {
	it("draws interior points of stored polygons, with the authority and the verbatim code on the label", () => {
		const points = sampleAgreementPoints(databasePath, { count: 6 })

		expect(points.length).toBeGreaterThan(0)

		for (const point of points) {
			expect(point.label).toContain("Fx")
			expect(point.localCode.length).toBeGreaterThan(0)
			expect(Number.isFinite(point.latitude)).toBe(true)
			expect(Number.isFinite(point.longitude)).toBe(true)
		}
	})

	it("is deterministic, so a disagreement can be looked at rather than re-rolled", () => {
		expect(sampleAgreementPoints(databasePath, { count: 6 })).toEqual(sampleAgreementPoints(databasePath, { count: 6 }))
	})
})
