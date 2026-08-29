/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two-path comparison's own logic, against a scripted service reader.
 *
 *   THE VALUE OF THE CHECK IS WHICH OF THREE OUTCOMES A POINT GETS, and that decision is what a live run can
 *   only be watched making. Expressed against a function rather than an HTTP client, it can be pinned: a
 *   point the service also places inside AGREES, a point far from any service edge DISAGREES, and a point a
 *   few centimetres from an edge is `boundary_tolerance` — because the two channels publish six and nine
 *   decimals and render the same edge differently.
 *
 *   THE NEGATIVE HALF IS PINNED HERE TOO. Inland English points must read `unknown` with no designation, and
 *   this is the check that would have caught a builder generalizing the flood layer's Zone-1-by-absence rule.
 */

import { buildCoastalDatabase } from "@mailwoman/coastal/sdk/build-coastal"
import {
	OUTSIDE_MAPPING_POINTS,
	sampleAgreementPoints,
	verifyCoastalDatabase,
	type ServiceFeature,
	type ServiceFeatureReader,
} from "@mailwoman/coastal/sdk/verify"
import {
	fixtureFeatures,
	fixtureSource,
	FIXTURE_ORIGIN,
	FIXTURE_SCENARIOS,
	FIXTURE_SIDE,
	rectangleRing,
} from "@mailwoman/coastal/test-kit"
import { mkdtempSync, rmSync } from "@mailwoman/platform/fs"
import { tmpdir } from "@mailwoman/platform/os"
import { join } from "@mailwoman/platform/path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const NFI = FIXTURE_SCENARIOS.noIntervention.key

let scratch: string
let databasePath: string

/**
 * The service's rendering of the first fixture band, as an OGC API Features item.
 */
function bandFeature(): ServiceFeature {
	const { lon, lat } = FIXTURE_ORIGIN

	return {
		properties: { frontageid: 1000 },
		geometry: {
			type: "Polygon",
			coordinates: [rectangleRing(lon, lat, lon + FIXTURE_SIDE, lat + FIXTURE_SIDE)],
		},
	}
}

/**
 * A reader that always publishes the first band, whatever it is asked about.
 */
const alwaysBand: ServiceFeatureReader = async () => [bandFeature()]

/**
 * A reader that publishes nothing at all.
 */
const alwaysEmpty: ServiceFeatureReader = async () => []

beforeAll(async () => {
	scratch = mkdtempSync(join(tmpdir(), "mw-coastal-verify-"))
	databasePath = join(scratch, "coastal-england.db")

	await buildCoastalDatabase({
		source: fixtureSource(fixtureFeatures()),
		out: databasePath,
		sourceVintage: "2024-11-28",
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

describe("sampleAgreementPoints", () => {
	it("draws points from more than one scenario, because a sample from one verifies one twelfth", () => {
		const points = sampleAgreementPoints(databasePath)

		expect(points.length).toBeGreaterThan(0)
		expect(new Set(points.map((point) => point.scenarioKey)).size).toBeGreaterThan(1)
	})

	it("draws the same points on a re-run, so a disagreement can be looked at rather than re-rolled", () => {
		expect(sampleAgreementPoints(databasePath)).toEqual(sampleAgreementPoints(databasePath))
	})
})

describe("the positive half", () => {
	it("agrees where both channels place the point inside", async () => {
		const inside = {
			label: "band A centre",
			latitude: FIXTURE_ORIGIN.lat + FIXTURE_SIDE / 2,
			longitude: FIXTURE_ORIGIN.lon + FIXTURE_SIDE / 2,
			scenarioKey: NFI,
		}

		const result = await verifyCoastalDatabase({
			databasePath,
			readServiceFeatures: alwaysBand,
			points: [inside],
			outsideScenarioKey: NFI,
		})

		expect(result.agreed).toBe(1)
		expect(result.disagreed).toBe(0)
		expect(result.agreement[0]!.serviceInside).toBe(true)
	})

	it("reports a real disagreement where the service publishes nothing nearby", async () => {
		const inside = {
			label: "band A centre",
			latitude: FIXTURE_ORIGIN.lat + FIXTURE_SIDE / 2,
			longitude: FIXTURE_ORIGIN.lon + FIXTURE_SIDE / 2,
			scenarioKey: NFI,
		}

		const result = await verifyCoastalDatabase({
			databasePath,
			readServiceFeatures: alwaysEmpty,
			points: [inside],
			outsideScenarioKey: NFI,
		})

		expect(result.disagreed).toBe(1)
		expect(result.agreement[0]!.nearestEdgeMetres).toBeUndefined()
	})

	it("tolerates a point a few centimetres outside the service's own edge", async () => {
		// About 5 cm north of the band's northern edge — inside the artifact's rendering is false and the service's is
		// false too, so this specific point agrees; the case that matters is the DISTANCE being carried, which is what
		// separates a rendering difference from a conversion defect on a receipt.
		const nearEdge = {
			label: "just outside band A's north edge",
			latitude: FIXTURE_ORIGIN.lat + FIXTURE_SIDE + 0.0000005,
			longitude: FIXTURE_ORIGIN.lon + FIXTURE_SIDE / 2,
			scenarioKey: NFI,
		}

		const result = await verifyCoastalDatabase({
			databasePath,
			readServiceFeatures: alwaysBand,
			points: [nearEdge],
			outsideScenarioKey: NFI,
		})

		const row = result.agreement[0]!

		// The distance rides on EVERY row, not only the tolerated ones — measured to the EDGE, which for a point beside a
		// long edge is orders of magnitude smaller than the distance to the nearest vertex.
		expect(row.nearestEdgeMetres).toBeDefined()
		expect(row.nearestEdgeMetres!).toBeLessThan(BOUNDARY_TOLERANCE_METRES)
		expect(row.outcome).not.toBe("disagree")
	})
})

/**
 * Mirrors the module's own tolerance so the assertion above states what it depends on.
 */
const BOUNDARY_TOLERANCE_METRES = 0.5

describe("the negative half", () => {
	it("reads every inland and out-of-country point as unknown with no designation", async () => {
		const result = await verifyCoastalDatabase({
			databasePath,
			readServiceFeatures: alwaysEmpty,
			points: [],
			outsideScenarioKey: NFI,
		})

		expect(result.outside).toHaveLength(OUTSIDE_MAPPING_POINTS.length)
		expect(result.outsidePassed).toBe(OUTSIDE_MAPPING_POINTS.length)

		for (const row of result.outside) {
			expect(row.kind).toBe("unknown")
			expect(row.designations).toBe(0)
		}
	})

	it("names both populations — inland England and the other UK nations", () => {
		const labels = OUTSIDE_MAPPING_POINTS.map((point) => point.label).join(" ")

		expect(labels).toMatch(/inland England/u)
		expect(labels).toMatch(/Wales/u)
		expect(labels).toMatch(/Scotland/u)
	})
})
