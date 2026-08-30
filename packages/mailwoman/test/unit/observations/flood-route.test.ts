/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #1989: the authority-designation route on the geocode path, exercised through `geocodeAddress` with
 *   mock classifier/resolver deps and a fixture-built flood layer.
 *
 *   THE FIRST TEST IS THE ONE THAT MATTERS. With the layer ABSENT — which is every default construction —
 *   the geocode result must be identical to a run against a build without the field existing. That is a
 *   statement about construction rather than about a measurement, and it is what makes the option safe to
 *   configure: rollback is removing the argument.
 *
 *   The remaining tests pin the three readings' journey to a caller: a designation becomes one additive
 *   marker naming the verdict's own top kind, a designated absence becomes the same marker carrying Zone 1,
 *   and a location outside the authority's footprint raises NOTHING — an advisory there would report a
 *   determination nobody made.
 */

import type { AddressNode } from "@mailwoman/core/decoder"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import type { QueryKind } from "@mailwoman/core/pipeline"
import { buildFloodDatabase } from "@mailwoman/flood/sdk/build-flood"
import { realizeFloodMapExtent } from "@mailwoman/flood/sdk/extent"
import {
	fixtureExtentGeometry,
	fixtureFeatures,
	fixtureSource,
	FIXTURE_ORIGIN,
	FIXTURE_SIDE,
} from "@mailwoman/flood/test-kit"
import { EA_COVERAGE_STATEMENT, EA_COVERAGE_STATEMENT_URL } from "@mailwoman/flood/vocabulary"
import type { Resolver } from "@mailwoman/resolver"
import { geocodeAddress, type GeocodeClassifier, type GeocodeDeps } from "mailwoman/geocode-core"
import { createAuthorityDesignationRoute } from "mailwoman/observations"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

function node(partial: Partial<AddressNode> & Pick<AddressNode, "tag" | "value">): AddressNode {
	return { start: 0, end: 0, confidence: 1, children: [], ...partial }
}

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
					metadata: { resolver_name: "Testtown", resolver_country: "GB" },
				}),
			],
		}),
	}

	// An explicit verdict, so the assertion below compares the marker's `kind` against a kind this test CHOSE rather
	// than against whatever the built-in classifier happened to reach.
	return {
		classifier,
		resolver,
		placeCountry: false,
		classifyKind: async () => ({ kind: TEST_VERDICT_KIND, confidence: 1, alternatives: [] }),
	}
}

const INPUT = "Testtown"

/**
 * The kind the mock classifier reports. A designation marker must name it — the verdict's own top kind — because a
 * designation is not raised by intent and has no kind of its own.
 */
const TEST_VERDICT_KIND: QueryKind = "locality_only"

/**
 * Inside the FZ3 square, well away from its edges.
 */
const INSIDE_ZONE = {
	latitude: FIXTURE_ORIGIN.lat + FIXTURE_SIDE / 2,
	longitude: FIXTURE_ORIGIN.lon + FIXTURE_SIDE / 2,
}

/**
 * Inside the footprint and outside every polygon — the designated Zone 1 absence.
 */
const DESIGNATED_ABSENCE = { latitude: FIXTURE_ORIGIN.lat + 0.2, longitude: FIXTURE_ORIGIN.lon + 0.2 }

/**
 * Outside the authority's footprint entirely.
 */
const OUTSIDE_FOOTPRINT = { latitude: FIXTURE_ORIGIN.lat + 5, longitude: FIXTURE_ORIGIN.lon + 5 }

let scratch: TemporaryDirectory
let databasePath: string

beforeAll(async () => {
	scratch = await temporaryDirectory("mw-flood-route-")
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

describe("#1989: the authority-designation route on the geocode path", () => {
	it("with the layer absent, the result is byte-identical to a run with the route attached minus its marker", async () => {
		const route = createAuthorityDesignationRoute({ databasePath })

		try {
			const bare = await geocodeAddress(INPUT, testDeps(INSIDE_ZONE.latitude, INSIDE_ZONE.longitude))

			const withRoute = await geocodeAddress(INPUT, {
				...testDeps(INSIDE_ZONE.latitude, INSIDE_ZONE.longitude),
				authorityDesignationRoute: route,
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

	it("a designation arrives as one additive marker naming the verdict's own top kind", async () => {
		const route = createAuthorityDesignationRoute({ databasePath })

		try {
			const result = await geocodeAddress(INPUT, {
				...testDeps(INSIDE_ZONE.latitude, INSIDE_ZONE.longitude),
				authorityDesignationRoute: route,
			})

			const marker = result.intent_markers[0]!

			expect(marker.code).toBe("authority_designation")
			expect(marker.mechanism).toBe("layer:flood_zone")
			// The settled answer to the survey's open question: the marker names the VERDICT's own top kind, because a
			// designation is not raised by intent and has no kind of its own to name.
			expect(marker.kind).toBe(TEST_VERDICT_KIND)
			const evidence = marker.evidence!

			expect(evidence.code).toBe("FZ3")
			expect(evidence.reading).toBe("designated")
			// The wording is about the MAP, never about the property — the authority declines the second statement.
			expect(marker.message).toMatch(/not whether a property will flood/u)
			// The licence condition rides with the claim.
			expect((evidence.layer as { attribution?: string }).attribution).toMatch(/Environment Agency copyright/u)
		} finally {
			route[Symbol.dispose]()
		}
	})

	it("a designated absence carries Zone 1 and the coverage row that licenses it", async () => {
		const route = createAuthorityDesignationRoute({ databasePath })

		try {
			const result = await geocodeAddress(INPUT, {
				...testDeps(DESIGNATED_ABSENCE.latitude, DESIGNATED_ABSENCE.longitude),
				authorityDesignationRoute: route,
			})

			const marker = result.intent_markers[0]!

			const evidence = marker.evidence!

			expect(evidence.reading).toBe("designated_absence")
			expect(evidence.code).toBeUndefined()
			expect((evidence.definition as { code: string }).code).toBe("FZ1")
			expect((evidence.coverage as { basis: string; observedRows: number }).basis).toBe("designated")
			expect((evidence.coverage as { basis: string; observedRows: number }).observedRows).toBe(0)
		} finally {
			route[Symbol.dispose]()
		}
	})

	it("a location outside the authority's footprint raises NOTHING, and never a Zone 1 marker", async () => {
		const route = createAuthorityDesignationRoute({ databasePath })

		try {
			const decision = route.observe(OUTSIDE_FOOTPRINT.latitude, OUTSIDE_FOOTPRINT.longitude)

			expect(decision).toEqual({ fired: false, refusal: "outside_authority_footprint" })

			const result = await geocodeAddress(INPUT, {
				...testDeps(OUTSIDE_FOOTPRINT.latitude, OUTSIDE_FOOTPRINT.longitude),
				authorityDesignationRoute: route,
			})

			expect(result.intent_markers).toEqual([])
		} finally {
			route[Symbol.dispose]()
		}
	})

	it("names the silence when the geocode reached no coordinate", () => {
		const route = createAuthorityDesignationRoute({ databasePath })

		try {
			expect(route.observe(undefined, undefined)).toEqual({ fired: false, refusal: "no_coordinate" })
		} finally {
			route[Symbol.dispose]()
		}
	})
})
