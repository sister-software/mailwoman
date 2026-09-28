/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The zoning route on the geocode path, exercised through `geocodeAddress` with mock classifier and resolver deps and a fixture-built layer.
 *
 *   The first test is the one that matters: with the layer absent the geocode result must be identical to a run with the field never built, which is what makes rollback removing the argument.
 *
 *   A designation becomes one additive marker naming the verdict's own top kind, with the authority's own code in the sentence and the generic type beside it, and a location with no zoning polygon raises no marker — the hardest case of the meaning-of-zero rule, since the publisher states `UNZ - Unzoned` as a positive value where it means it.
 */

import type { AddressNode } from "@mailwoman/core/decoder"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import type { QueryKind } from "@mailwoman/core/pipeline"
import type { Resolver } from "@mailwoman/core/resolver"
import { buildZoningDatabase } from "@mailwoman/zoning/sdk/build-zoning"
import { fixtureFeatures, fixtureSource, FIXTURE_ORIGIN, FIXTURE_PLANS, FIXTURE_SIDE } from "@mailwoman/zoning/test-kit"
import { geocodeAddress, type GeocodeClassifier, type GeocodeDeps } from "mailwoman/geocode"
import { createZoningDesignationRoute, describeZoningDesignation } from "mailwoman/observations"
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
					metadata: { resolver_name: "Testtown", resolver_country: "IE" },
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

/**
 * Inside the first fixture zone, where both plans hold a polygon over the same ground.
 */
const INSIDE_ZONE = {
	latitude: FIXTURE_ORIGIN.lat + FIXTURE_SIDE / 2,
	longitude: FIXTURE_ORIGIN.lon + FIXTURE_SIDE / 2,
}

/**
 * Well away from every fixture zone, the reading this layer must never turn into "no restriction applies".
 */
const NO_DESIGNATION = { latitude: FIXTURE_ORIGIN.lat + 0.2, longitude: FIXTURE_ORIGIN.lon + 0.2 }

/**
 * Inside the zone the authority states as unzoned — a positive designation rather than an absence.
 */
const INSIDE_UNZONED = {
	latitude: FIXTURE_ORIGIN.lat + FIXTURE_SIDE / 2,
	longitude: FIXTURE_ORIGIN.lon + 4.5 * FIXTURE_SIDE,
}

let scratch: TemporaryDirectory
let databasePath: PathBuilder

beforeAll(async () => {
	scratch = await temporaryDirectory("mw-zoning-route-")
	databasePath = scratch.path("zoning-ireland.db")

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

afterAll(() => scratch[Symbol.asyncDispose]())

describe("#1995: the zoning route on the geocode path", () => {
	it("with the layer absent, the result is byte-identical to a run with the route attached minus its marker", async () => {
		const route = createZoningDesignationRoute({ databasePath })

		try {
			const bare = await geocodeAddress(INPUT, testDeps(INSIDE_ZONE.latitude, INSIDE_ZONE.longitude))

			const withRoute = await geocodeAddress(INPUT, {
				...testDeps(INSIDE_ZONE.latitude, INSIDE_ZONE.longitude),
				zoningDesignationRoute: route,
			})

			expect(bare.intent_markers).toEqual([])
			expect(withRoute.intent_markers).toHaveLength(1)

			const { intent_markers: withMarker, ...restWithRoute } = withRoute
			const { intent_markers: withoutMarker, ...restBare } = bare

			expect(withMarker).toHaveLength(1)
			expect(withoutMarker).toEqual([])
			expect(restWithRoute).toEqual(restBare)
		} finally {
			route[Symbol.dispose]()
		}
	})

	it("puts the authority's OWN code in the message, with the generic type beside it rather than instead of it", async () => {
		const route = createZoningDesignationRoute({ databasePath })

		try {
			const result = await geocodeAddress(INPUT, {
				...testDeps(INSIDE_ZONE.latitude, INSIDE_ZONE.longitude),
				zoningDesignationRoute: route,
			})

			const marker = result.intent_markers![0]!

			expect(marker.code).toBe("authority_designation")
			expect(marker.mechanism).toBe("layer:zoning")
			expect(marker.kind).toBe(TEST_VERDICT_KIND)

			// The local code leads because the generic type cannot reconstruct it.
			expect(marker.message).toMatch(/"R2 - Existing Residential"/u)
			expect(marker.message).toMatch(/IE-GZT R2/u)
			expect(marker.message.indexOf("R2 - Existing Residential")).toBeLessThan(marker.message.indexOf("IE-GZT R2"))
			expect(marker.message).toMatch(/not what may be built there/u)

			// The plan is in the sentence because a zone exists inside one.
			expect(marker.message).toContain(FIXTURE_PLANS.development.name)
		} finally {
			route[Symbol.dispose]()
		}
	})

	it("carries every plan covering the coordinate, each with its own window", async () => {
		const route = createZoningDesignationRoute({ databasePath })

		try {
			const decision = route.observe(INSIDE_ZONE.latitude, INSIDE_ZONE.longitude)

			expect(decision.fired).toBe(true)

			if (!decision.fired) return

			expect(decision.observation.designations).toHaveLength(2)

			expect(new Set(decision.observation.designations.map((entry) => entry.plan.planID))).toEqual(
				new Set([FIXTURE_PLANS.development.id, FIXTURE_PLANS.localArea.id])
			)

			for (const designation of decision.observation.designations) {
				expect(designation.plan.validFrom).toBeTruthy()
				expect(designation.plan.validTo).toBeTruthy()
				// `1` means not superseded, a different fact from "in force today".
				expect(designation.plan.currentPlan).toBe(1)
				expect(designation.provenanceGrade).toBe("authoritative")
			}

			// The one-line description carries the authority, the code and the plan,
			// so a receipt cannot lose which of them spoke.
			expect(describeZoningDesignation(decision.observation)).toMatch(/Fixture County Council/u)
			expect(describeZoningDesignation(decision.observation)).toMatch(/R2 - Existing Residential/u)
			expect(describeZoningDesignation(decision.observation)).toMatch(/build-local/u)
		} finally {
			route[Symbol.dispose]()
		}
	})

	it("carries the coverage limit, so an answer never reads as a claim that no restriction applies", async () => {
		const route = createZoningDesignationRoute({ databasePath })

		try {
			const result = await geocodeAddress(INPUT, {
				...testDeps(INSIDE_ZONE.latitude, INSIDE_ZONE.longitude),
				zoningDesignationRoute: route,
			})

			const evidence = result.intent_markers![0]!.evidence as Record<string, unknown>
			const coverage = evidence.coverage as Record<string, unknown>

			expect(coverage.basis).toBe("source_present")
			expect(evidence.coverageLimit).toMatch(/records source presence only/u)
			expect((evidence.limits as string[]).join(" ")).toMatch(/not published here as legal definitions/u)
			expect((evidence.layer as Record<string, unknown>).tier).toBe("build-local")
		} finally {
			route[Symbol.dispose]()
		}
	})

	it("raises NOTHING where no adopted plan assigns a designation", async () => {
		const route = createZoningDesignationRoute({ databasePath })

		try {
			const result = await geocodeAddress(INPUT, {
				...testDeps(NO_DESIGNATION.latitude, NO_DESIGNATION.longitude),
				zoningDesignationRoute: route,
			})

			// An advisory here would be a determination nobody made, since the location
			// may be outside any plan area, unzoned land inside one, in a jurisdiction
			// that has never zoned, or in one nobody has published.
			expect(result.intent_markers).toEqual([])

			const decision = route.observe(NO_DESIGNATION.latitude, NO_DESIGNATION.longitude)

			expect(decision.fired).toBe(false)

			if (decision.fired) return

			expect(decision.refusal).toBe("no_designation_here")
		} finally {
			route[Symbol.dispose]()
		}
	})

	it("DOES raise where the authority states unzoned land positively, which is what makes silence silence", async () => {
		const route = createZoningDesignationRoute({ databasePath })

		try {
			const decision = route.observe(INSIDE_UNZONED.latitude, INSIDE_UNZONED.longitude)

			expect(decision.fired).toBe(true)

			if (!decision.fired) return

			expect(decision.observation.designations[0]!.unzoned).toBe(true)
			expect(decision.observation.designations[0]!.localCode).toBe("UNZ - Unzoned")
		} finally {
			route[Symbol.dispose]()
		}
	})

	it("names a coordinate-less answer as its own refusal rather than as a missing designation", async () => {
		const route = createZoningDesignationRoute({ databasePath })

		try {
			const decision = route.observe(null, undefined)

			expect(decision.fired).toBe(false)

			if (decision.fired) return

			expect(decision.refusal).toBe("no_coordinate")
		} finally {
			route[Symbol.dispose]()
		}
	})
})
