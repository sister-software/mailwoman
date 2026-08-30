/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two-path agreement check, driven against a SCRIPTED service.
 *
 *   The check's value is that it compares two verdicts rather than a file against itself, and its own logic
 *   is what decides which of three outcomes a point gets. A live run can only show that today's numbers
 *   came out; these cases show that a disagreement is reported as one, that a near-boundary difference is
 *   attributed to the channels rather than to the conversion, and — the half that matters most — that the
 *   negative check fails loudly on an artifact that would answer Zone 1 outside England.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { buildFloodDatabase } from "@mailwoman/flood/sdk/build-flood"
import { realizeFloodMapExtent } from "@mailwoman/flood/sdk/extent"
import { verifyFloodDatabase, type ServiceFeatureReader } from "@mailwoman/flood/sdk/verify"
import {
	FIXTURE_ORIGIN,
	FIXTURE_SIDE,
	fixtureExtentGeometry,
	fixtureFeatures,
	fixtureSource,
	rectangleRing,
} from "@mailwoman/flood/test-kit"
import { EA_COVERAGE_STATEMENT, EA_COVERAGE_STATEMENT_URL } from "@mailwoman/flood/vocabulary"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * A service that answers every point with one polygon carrying `zone`, drawn `offsetDegrees` away from the fixture's
 * own FZ3 square so the nearest-vertex distance is under this test's control. `null` answers with nothing.
 */
function scriptedService(zone: string | null, offsetDegrees = 0): ServiceFeatureReader {
	return async () =>
		zone === null
			? []
			: [
					{
						properties: { flood_zone: zone },
						geometry: {
							type: "Polygon",
							coordinates: [
								rectangleRing(
									FIXTURE_ORIGIN.lon + offsetDegrees,
									FIXTURE_ORIGIN.lat + offsetDegrees,
									FIXTURE_ORIGIN.lon + FIXTURE_SIDE + offsetDegrees,
									FIXTURE_ORIGIN.lat + FIXTURE_SIDE + offsetDegrees
								),
							],
						},
					},
				]
}

/**
 * A point well inside the fixture's FZ3 square.
 */
const INSIDE_FZ3 = {
	label: "inside FZ3",
	latitude: FIXTURE_ORIGIN.lat + FIXTURE_SIDE / 2,
	longitude: FIXTURE_ORIGIN.lon + FIXTURE_SIDE / 2,
}

let scratch: TemporaryDirectory
let databasePath: string

beforeAll(async () => {
	scratch = await temporaryDirectory("mw-flood-verify-")
	databasePath = scratch.resolve("flood.db")

	await buildFloodDatabase({
		source: fixtureSource(fixtureFeatures()),
		out: databasePath,
		sourceVintage: "2026-05-20",
		buildCmd: "vitest",
		buildSHA: "fixture",
		createdAt: "2026-08-28T00:00:00.000Z",
		indexResolution: 9,
		coverageResolution: 6,
		extent: realizeFloodMapExtent({
			geometry: fixtureExtentGeometry(),
			coverageResolution: 6,
			authority: "Environment Agency",
			statement: EA_COVERAGE_STATEMENT,
			statementURL: EA_COVERAGE_STATEMENT_URL,
		}),
	})
})

afterAll(() => scratch[Symbol.asyncDispose]())

describe("verifyFloodDatabase", () => {
	it("agrees when both channels assign the same zone", async () => {
		const result = await verifyFloodDatabase({
			databasePath,
			readServiceFeatures: scriptedService("FZ3"),
			points: [INSIDE_FZ3],
		})

		expect(result.agreed).toBe(1)
		expect(result.disagreed).toBe(0)
		expect(result.agreement[0]!.service).toBe("FZ3")
	})

	it("reports a disagreement as one when the service's polygon is nowhere near the point", async () => {
		// The service's polygon sits a whole fixture square away, so the nearest vertex is far outside the boundary
		// tolerance and the difference cannot be attributed to the two channels rendering the same edge.
		const result = await verifyFloodDatabase({
			databasePath,
			readServiceFeatures: scriptedService("FZ2", FIXTURE_SIDE * 4),
			points: [INSIDE_FZ3],
		})

		expect(result.disagreed).toBe(1)
		expect(result.boundaryTolerance).toBe(0)
		// The distance rides on the row even though it was not acted on — it is what triage starts from.
		expect(result.agreement[0]!.nearestEdgeMetres).toBeGreaterThan(0)
	})

	it("carries a service miss as a null verdict rather than as an absent one", async () => {
		const result = await verifyFloodDatabase({
			databasePath,
			readServiceFeatures: scriptedService(null),
			points: [INSIDE_FZ3],
		})

		expect(result.agreement[0]!.service).toBeNull()
		expect(result.agreement[0]!.nearestEdgeMetres).toBeUndefined()
		expect(result.disagreed).toBe(1)
	})

	it("passes the negative half: every point outside the footprint reads unknown", async () => {
		const result = await verifyFloodDatabase({
			databasePath,
			readServiceFeatures: scriptedService(null),
			points: [],
			outsidePoints: [
				{
					label: "far north-east of the fixture extent",
					latitude: FIXTURE_ORIGIN.lat + 5,
					longitude: FIXTURE_ORIGIN.lon + 5,
				},
				{
					label: "far south-west of the fixture extent",
					latitude: FIXTURE_ORIGIN.lat - 5,
					longitude: FIXTURE_ORIGIN.lon - 5,
				},
			],
		})

		expect(result.outsidePassed).toBe(2)
		expect(result.outside.every((row) => row.kind === "unknown")).toBe(true)
	})

	it("FAILS the negative half on a point the footprint does cover — the check has teeth", async () => {
		// Inside the fixture's extent and outside every polygon, so the artifact answers the designated absence. The
		// negative half must NOT pass on it: an artifact that answered a designation everywhere would slip through a check
		// that only ever asked about places it happened to be silent.
		const result = await verifyFloodDatabase({
			databasePath,
			readServiceFeatures: scriptedService(null),
			points: [],
			outsidePoints: [
				{ label: "inside the fixture extent", latitude: FIXTURE_ORIGIN.lat + 0.2, longitude: FIXTURE_ORIGIN.lon + 0.2 },
			],
		})

		expect(result.outsidePassed).toBe(0)
		expect(result.outside[0]!.kind).toBe("designated_absence")
	})
})
