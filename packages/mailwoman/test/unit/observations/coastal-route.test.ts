/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The coastal-erosion route on the geocode path, exercised through `geocodeAddress` with mock classifier and resolver deps and a fixture-built layer.
 *
 *   The first test is the one that matters: with the layer absent the geocode result must be identical to a run with the field never built, which is what makes rollback removing the argument.
 *
 *   A designation becomes one additive marker naming the verdict's own top kind, and a location with no erosion polygon raises no marker — the inversion of the flood route, because ncerm publishes no definition under which silence is an advisory.
 */

import { buildCoastalDatabase } from "@mailwoman/coastal/sdk/build-coastal"
import {
	fixtureFeatures,
	fixtureSource,
	FIXTURE_ORIGIN,
	FIXTURE_SCENARIOS,
	FIXTURE_SIDE,
} from "@mailwoman/coastal/test-kit"
import type { AddressNode } from "@mailwoman/core/decoder"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import type { QueryKind } from "@mailwoman/core/pipeline"
import type { Resolver } from "@mailwoman/core/resolver"
import { geocodeAddress, type GeocodeClassifier, type GeocodeDeps } from "mailwoman/geocode"
import { createCoastalErosionRoute, describeCoastalErosion } from "mailwoman/observations"
import type { PathBuilder } from "path-ts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

function node(partial: Partial<AddressNode> & Pick<AddressNode, "tag" | "value">): AddressNode {
	return { start: 0, end: 0, confidence: 1, children: [], ...partial }
}

/**
 * The kind the mock classifier reports: a designation marker must name the verdict's
 * own top kind because a designation is not raised by intent.
 */
const TEST_VERDICT_KIND: QueryKind = "locality_only"

/**
 * A minimal always-resolves engine answering at `latitude`/`longitude`,
 * so the coordinate the route is handed is the one the test chose.
 */
function testDeps(latitude: number, longitude: number): GeocodeDeps {
	const classifier: GeocodeClassifier = {
		parse: async (text) => ({ raw: text, roots: [node({ tag: "locality", value: "Testtown" })] }),
	}

	const resolver: Resolver = {
		resolveTree: async (tree) => ({
			raw: tree.raw,
			roots: [
				node({
					tag: "locality",
					value: "Testtown",
					lat: latitude,
					lon: longitude,
					placeID: "wof:999",
					metadata: { resolver_name: "Testtown", resolver_country: "GB" },
				}),
			],
		}),
	}

	return {
		classifier,
		resolver,
		placeCountry: false,
		classifyKind: async () => ({ kind: TEST_VERDICT_KIND, confidence: 1, alternatives: [] }),
	}
}

const INPUT = "Testtown"

const NFI = FIXTURE_SCENARIOS.noIntervention.key
const SMP = FIXTURE_SCENARIOS.withPlan.key

/**
 * Inside the first fixture band, where both scenarios hold a polygon with different distances.
 */
const INSIDE_BAND = {
	latitude: FIXTURE_ORIGIN.lat + FIXTURE_SIDE / 2,
	longitude: FIXTURE_ORIGIN.lon + FIXTURE_SIDE / 2,
}

/**
 * Well away from every fixture band, the reading this layer must never turn into a reassurance.
 */
const NO_DESIGNATION = { latitude: FIXTURE_ORIGIN.lat + 0.2, longitude: FIXTURE_ORIGIN.lon + 0.2 }

let scratch: TemporaryDirectory
let databasePath: PathBuilder

beforeAll(async () => {
	scratch = await temporaryDirectory("mw-coastal-route-")
	databasePath = scratch.path("coastal-england.db")

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

afterAll(() => scratch[Symbol.asyncDispose]())

describe("#1993: the coastal-erosion route on the geocode path", () => {
	it("with the layer absent, the result is byte-identical to a run with the route attached minus its marker", async () => {
		using route = createCoastalErosionRoute({ databasePath })

		const bare = await geocodeAddress(INPUT, testDeps(INSIDE_BAND.latitude, INSIDE_BAND.longitude))

		const withRoute = await geocodeAddress(INPUT, {
			...testDeps(INSIDE_BAND.latitude, INSIDE_BAND.longitude),
			coastalErosionRoute: route,
		})

		expect(bare.intent_markers).toEqual([])
		expect(withRoute.intent_markers).toHaveLength(1)

		const { intent_markers: withMarker, ...restWithRoute } = withRoute
		const { intent_markers: withoutMarker, ...restBare } = bare

		expect(withMarker).toHaveLength(1)
		expect(withoutMarker).toEqual([])
		expect(restWithRoute).toEqual(restBare)
	})

	it("names the scenario in the message, not only in the evidence", async () => {
		using route = createCoastalErosionRoute({ databasePath, scenarioKey: NFI })

		const result = await geocodeAddress(INPUT, {
			...testDeps(INSIDE_BAND.latitude, INSIDE_BAND.longitude),
			coastalErosionRoute: route,
		})

		const marker = result.intent_markers![0]!

		expect(marker.code).toBe("authority_designation")
		expect(marker.mechanism).toBe("layer:coastal_erosion")
		expect(marker.kind).toBe(TEST_VERDICT_KIND)

		// The scenario is in the sentence, or a 2105 projection could be taken for a present-day designation.
		expect(marker.message).toMatch(/under scenario NFI_2055_0CC/u)
		expect(marker.message).toMatch(/No Future Intervention/u)
		expect(marker.message).toMatch(/not whether a property will erode/u)

		const evidence = marker.evidence as Record<string, unknown>
		const scenario = evidence.scenario as Record<string, unknown>

		expect(scenario.key).toBe(NFI)
		expect(scenario.horizon).toBe(2055)
		expect(scenario.climateAllowance).toBe("0CC")
	})

	it("answers the same coordinate differently under a different scenario", async () => {
		using underNFI = createCoastalErosionRoute({ databasePath, scenarioKey: NFI })
		using underSMP = createCoastalErosionRoute({ databasePath, scenarioKey: SMP })

		const nfiDecision = underNFI.observe(INSIDE_BAND.latitude, INSIDE_BAND.longitude)
		const smpDecision = underSMP.observe(INSIDE_BAND.latitude, INSIDE_BAND.longitude)

		expect(nfiDecision.fired).toBe(true)
		expect(smpDecision.fired).toBe(true)

		if (!nfiDecision.fired || !smpDecision.fired) return

		expect(nfiDecision.observation.designations[0]!.distanceM).toBe(12)
		expect(smpDecision.observation.designations[0]!.distanceM).toBe(310)

		// The one-line description carries the scenario too, so a receipt cannot lose which question was answered.
		expect(describeCoastalErosion(nfiDecision.observation)).toMatch(/NFI_2055_0CC/u)
		expect(describeCoastalErosion(smpDecision.observation)).toMatch(/SMP_2105_95CC/u)
	})

	it("carries the coverage limit, so an answer never reads as a claim about what is NOT at risk", async () => {
		using route = createCoastalErosionRoute({ databasePath })

		const result = await geocodeAddress(INPUT, {
			...testDeps(INSIDE_BAND.latitude, INSIDE_BAND.longitude),
			coastalErosionRoute: route,
		})

		const evidence = result.intent_markers![0]!.evidence as Record<string, unknown>
		const coverage = evidence.coverage as Record<string, unknown>

		expect(coverage.basis).toBe("source_present")
		expect(evidence.coverageLimit).toMatch(/no coverage statement/u)
		expect((evidence.limits as string[]).join(" ")).toMatch(/cannot provide details for individual properties/u)
	})

	it("raises NOTHING where the authority's mapping assigns no zone", async () => {
		using route = createCoastalErosionRoute({ databasePath })

		const result = await geocodeAddress(INPUT, {
			...testDeps(NO_DESIGNATION.latitude, NO_DESIGNATION.longitude),
			coastalErosionRoute: route,
		})

		// An advisory here would be an unverified determination, so the response reports a refusal.
		expect(result.intent_markers).toEqual([])

		const decision = route.observe(NO_DESIGNATION.latitude, NO_DESIGNATION.longitude)

		expect(decision.fired).toBe(false)

		if (decision.fired) return

		expect(decision.refusal).toBe("no_designation_here")
	})

	it("names a coordinate-less answer as its own refusal rather than as a missing designation", async () => {
		using route = createCoastalErosionRoute({ databasePath })

		const decision = route.observe(null, undefined)

		expect(decision.fired).toBe(false)

		if (decision.fired) return

		expect(decision.refusal).toBe("no_coordinate")
	})
})
