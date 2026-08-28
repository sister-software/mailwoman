/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #1991: the soil-capability route on the geocode path, exercised through `geocodeAddress` with mock
 *   classifier/resolver deps and a fixture-built soil layer.
 *
 *   THE FIRST TEST IS THE ONE THAT MATTERS. With the layer ABSENT — which is every default construction —
 *   the geocode result must be identical to a run against a build without the field existing. That is a
 *   statement about construction rather than about a measurement, and it is what makes the option safe to
 *   configure: rollback is removing the argument.
 *
 *   THE REST PIN THE THREE READINGS' JOURNEY TO A CALLER: a rated cell becomes one additive marker naming
 *   the verdict's own top kind and carrying the share the class rests on, a mapped-but-unrated cell becomes
 *   the same marker with NO class and the absence shares that say why, and a location outside every built
 *   survey area raises NOTHING — an advisory there would report a survey nobody ran.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AddressNode } from "@mailwoman/core/decoder"
import type { QueryKind } from "@mailwoman/core/pipeline"
import type { Resolver } from "@mailwoman/resolver"
import { buildSoilDatabase } from "@mailwoman/soil/sdk/build-soil"
import {
	FIXTURE_ORIGIN,
	FIXTURE_SIDE,
	fixtureAttributes,
	fixtureDelineations,
	fixtureOutline,
	fixtureSource,
} from "@mailwoman/soil/test-kit"
import { geocodeAddress, type GeocodeClassifier, type GeocodeDeps } from "mailwoman/geocode-core"
import { createSoilCapabilityRoute } from "mailwoman/observations"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

function node(partial: Partial<AddressNode> & Pick<AddressNode, "tag" | "value">): AddressNode {
	return { start: 0, end: 0, confidence: 1, children: [], ...partial }
}

/**
 * The kind the mock classifier reports. A designation marker must name it — the verdict's own top kind — because a
 * designation is not raised by intent and has no kind of its own.
 */
const TEST_VERDICT_KIND: QueryKind = "locality_only"

/**
 * A minimal always-resolves engine that answers at `latitude`/`longitude`, so the coordinate the route is handed is the
 * one this test chose.
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
					metadata: { resolver_name: "Testtown", resolver_country: "US" },
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
 * Inside the mixed map unit — 45/35/20 across three capability classes.
 */
const INSIDE_MIXED = {
	latitude: FIXTURE_ORIGIN.lat + FIXTURE_SIDE / 2,
	longitude: FIXTURE_ORIGIN.lon + 0.5 * FIXTURE_SIDE,
}

/**
 * Inside the unrated map unit — the survey mapped this ground and rated nothing here.
 */
const INSIDE_UNRATED = {
	latitude: FIXTURE_ORIGIN.lat + FIXTURE_SIDE / 2,
	longitude: FIXTURE_ORIGIN.lon + 3.5 * FIXTURE_SIDE,
}

/**
 * Outside every built survey area.
 */
const OUTSIDE_SURVEY = { latitude: FIXTURE_ORIGIN.lat + 5, longitude: FIXTURE_ORIGIN.lon + 5 }

let scratch: string
let databasePath: string

beforeAll(async () => {
	scratch = mkdtempSync(join(tmpdir(), "mw-soil-route-"))
	databasePath = join(scratch, "soil.db")

	const delineations = fixtureDelineations()

	await buildSoilDatabase({
		areas: [
			{
				attributes: fixtureAttributes(),
				outline: fixtureOutline(),
				source: fixtureSource(delineations),
				declaredFeatureCount: delineations.length,
			},
		],
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
})

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true })
})

describe("#1991: the soil-capability route on the geocode path", () => {
	it("with the layer absent, the result is byte-identical to a run with the route attached minus its marker", async () => {
		const route = createSoilCapabilityRoute({ databasePath })

		try {
			const bare = await geocodeAddress(INPUT, testDeps(INSIDE_MIXED.latitude, INSIDE_MIXED.longitude))

			const withRoute = await geocodeAddress(INPUT, {
				...testDeps(INSIDE_MIXED.latitude, INSIDE_MIXED.longitude),
				soilCapabilityRoute: route,
			})

			expect(bare.intent_markers).toEqual([])
			expect(withRoute.intent_markers).toHaveLength(1)

			const { intent_markers: withMarker, ...restWithRoute } = withRoute
			const { intent_markers: withoutMarker, ...restBare } = bare

			expect(withMarker).toHaveLength(1)
			expect(withoutMarker).toEqual([])
			expect(restWithRoute).toEqual(restBare)
		} finally {
			route.close()
		}
	})

	it("carries the class WITH the share it rests on, and never the class alone", async () => {
		const route = createSoilCapabilityRoute({ databasePath })

		try {
			const result = await geocodeAddress(INPUT, {
				...testDeps(INSIDE_MIXED.latitude, INSIDE_MIXED.longitude),
				soilCapabilityRoute: route,
			})

			const marker = result.intent_markers![0]!

			expect(marker.code).toBe("authority_designation")
			expect(marker.mechanism).toBe("layer:soil_capability")
			expect(marker.kind).toBe(TEST_VERDICT_KIND)

			const evidence = marker.evidence as Record<string, unknown>

			expect(evidence.topClass).toBe("2")
			// A 45% plurality. Reporting the class without this number would manufacture certainty NRCS itself declines to
			// manufacture — its own aggregation ships the share beside the class, with an observed minimum of 2%.
			expect(evidence.topClassShare as number).toBeLessThan(0.5)
			expect(marker.message).toMatch(/not whether the land can be farmed/u)
			expect(marker.message).toMatch(/% of the cell/u)
		} finally {
			route.close()
		}
	})

	it("carries the survey vintage beside the refresh, so a 2025 date never reads as the survey's currency", async () => {
		const route = createSoilCapabilityRoute({ databasePath })

		try {
			const result = await geocodeAddress(INPUT, {
				...testDeps(INSIDE_MIXED.latitude, INSIDE_MIXED.longitude),
				soilCapabilityRoute: route,
			})

			const evidence = result.intent_markers![0]!.evidence as Record<string, Record<string, unknown>>

			expect(evidence.surveyArea!.saverest).toBe("2025-09-09")
			expect(evidence.surveyArea!.surveySourceDate).toBe("1960")
			expect(evidence.layer!.attribution).toMatch(/Natural Resources Conservation Service/u)
		} finally {
			route.close()
		}
	})

	it("reports a mapped-but-unrated cell as a reading with no class rather than as a low one", async () => {
		const route = createSoilCapabilityRoute({ databasePath })

		try {
			const result = await geocodeAddress(INPUT, {
				...testDeps(INSIDE_UNRATED.latitude, INSIDE_UNRATED.longitude),
				soilCapabilityRoute: route,
			})

			const evidence = result.intent_markers![0]!.evidence as Record<string, unknown>
			const distribution = evidence.distribution as Record<string, number>

			expect(evidence.reading).toBe("designated_no_rating")
			expect(evidence.topClass).toBeUndefined()
			expect(distribution.unratedShare).toBeGreaterThan(0.9)
		} finally {
			route.close()
		}
	})

	it("raises NOTHING outside every built survey area", async () => {
		const route = createSoilCapabilityRoute({ databasePath })

		try {
			const result = await geocodeAddress(INPUT, {
				...testDeps(OUTSIDE_SURVEY.latitude, OUTSIDE_SURVEY.longitude),
				soilCapabilityRoute: route,
			})

			// An advisory here would report a survey nobody ran.
			expect(result.intent_markers).toEqual([])

			expect(route.observe(OUTSIDE_SURVEY.latitude, OUTSIDE_SURVEY.longitude)).toEqual({
				fired: false,
				refusal: "outside_surveyed_area",
			})
		} finally {
			route.close()
		}
	})

	it("names its silence when the geocode reached no coordinate", () => {
		const route = createSoilCapabilityRoute({ databasePath })

		try {
			expect(route.observe(undefined, undefined)).toEqual({ fired: false, refusal: "no_coordinate" })
		} finally {
			route.close()
		}
	})
})
