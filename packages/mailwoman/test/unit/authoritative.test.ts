/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #1901: the authoritative-provider boundary, exercised through `geocodeAddress` with mock
 *   classifier/resolver deps and the shipped fixture provider. The suite pins the contract's four
 *   distinctions — matched, ambiguous-not-collapsed, refused-is-not-a-miss, transport-error-is-not-
 *   silence — plus the two invariants that make the boundary safe to configure: the open result is
 *   byte-identical without a provider, and provider assertions never rewrite Mailwoman's own answer.
 */

import type { AddressNode } from "@mailwoman/core/decoder"
import {
	type AuthoritativeQuery,
	AuthoritativeResponseStatus,
	createFixtureAuthoritativeProvider,
	fixtureExactMatch,
} from "@mailwoman/core/resolver"
import type { Resolver } from "@mailwoman/resolver"
import { geocodeAddress, type GeocodeClassifier, type GeocodeDeps } from "mailwoman/geocode-core"
import { describe, expect, it } from "vitest"

function node(partial: Partial<AddressNode> & Pick<AddressNode, "tag" | "value">): AddressNode {
	return { start: 0, end: 0, confidence: 1, children: [], ...partial }
}

/**
 * A minimal always-resolves engine: one locality node with a coordinate, so the open result is a stable admin answer
 * the provider block can be compared against.
 */
function testDeps(): GeocodeDeps {
	const classifier: GeocodeClassifier = {
		parse: async (text) => ({
			raw: text,
			roots: [node({ tag: "locality", value: "Testtown" }), node({ tag: "postcode", value: "TT1 1TT" })],
		}),
	}

	const resolver: Resolver = {
		resolveTree: async (tree) => ({
			raw: tree.raw,
			roots: [
				node({
					tag: "locality",
					value: "Testtown",
					lat: 51.5,
					lon: -0.1,
					placeID: "wof:999",
					metadata: { resolver_name: "Testtown", resolver_country: "GB" },
				}),
				node({ tag: "postcode", value: "TT1 1TT" }),
			],
		}),
	}

	return { classifier, resolver, placeCountry: false }
}

const INPUT = "1 Example Terrace, Testtown TT1 1TT"

describe("#1901: the authoritative provider block on GeocodeResult", () => {
	it("an exact fixture match arrives as a `matched` block with the provider's assertions verbatim", async () => {
		const provider = createFixtureAuthoritativeProvider({
			rules: [{ matchOn: "example terrace", response: fixtureExactMatch() }],
		})

		const result = await geocodeAddress(INPUT, { ...testDeps(), authoritativeProvider: provider })

		expect(result.authoritative).toBeDefined()
		expect(result.authoritative!.provider).toBe("fixture")
		expect(result.authoritative!.status).toBe("matched")
		expect(result.authoritative!.matches).toHaveLength(1)
		expect(result.authoritative!.matches![0]!.object_ids).toEqual({ uprn: "000000000001" })
		expect(result.authoritative!.matches![0]!.precision).toBe("rooftop")
		expect(result.authoritative!.license).toBe("fixture-terms-v1")
		expect(result.authoritative!.attribution).toMatch(/Synthetic fixture/)
	})

	it("provider assertions never rewrite the open answer — Mailwoman's coordinate survives an exact match elsewhere", async () => {
		const provider = createFixtureAuthoritativeProvider({
			rules: [{ matchOn: "example terrace", response: fixtureExactMatch({ latitude: 0.5, longitude: 0.5 }) }],
		})

		const result = await geocodeAddress(INPUT, { ...testDeps(), authoritativeProvider: provider })

		// The resolver's own answer, untouched by the provider's different coordinate.
		expect(result.lat).toBe(51.5)
		expect(result.lon).toBe(-0.1)
		expect(result.authoritative!.matches![0]!.lat).toBe(0.5)
	})

	it("an ambiguous response keeps EVERY candidate in the provider's order", async () => {
		const first = fixtureExactMatch().matches[0]!

		const provider = createFixtureAuthoritativeProvider({
			rules: [
				{
					matchOn: "example terrace",
					response: {
						status: AuthoritativeResponseStatus.Ambiguous,
						matches: [
							{ ...first, providerPlaceID: "fixture-place-0001" },
							{ ...first, providerPlaceID: "fixture-place-0002", matchStatus: "approximate" },
						],
					},
				},
			],
		})

		const result = await geocodeAddress(INPUT, { ...testDeps(), authoritativeProvider: provider })

		expect(result.authoritative!.status).toBe("ambiguous")

		expect(result.authoritative!.matches!.map((m) => m.provider_place_id)).toEqual([
			"fixture-place-0001",
			"fixture-place-0002",
		])

		expect(result.authoritative!.matches![1]!.match_status).toBe("approximate")
	})

	it("a refusal is a spoken outcome: status `refused`, no matches field, and the open answer stands", async () => {
		const provider = createFixtureAuthoritativeProvider({ rules: [] })

		const result = await geocodeAddress(INPUT, { ...testDeps(), authoritativeProvider: provider })

		expect(result.authoritative!.status).toBe("refused")
		expect(result.authoritative!.matches).toBeUndefined()
		// Distinct from a parse failure: the parse's components are all still here.
		expect(result.locality).toBe("Testtown")
		expect(result.lat).toBe(51.5)
	})

	it("a throwing provider is a `transport_error` block, never a missing one and never a failed geocode", async () => {
		const provider = {
			name: "flaky",
			lookup: async (): Promise<never> => {
				throw new Error("connect ETIMEDOUT")
			},
		}

		const result = await geocodeAddress(INPUT, { ...testDeps(), authoritativeProvider: provider })

		expect(result.authoritative).toEqual({
			provider: "flaky",
			status: "transport_error",
			error: "connect ETIMEDOUT",
		})

		expect(result.lat).toBe(51.5)
	})

	it("no provider configured → no block, and the result is deep-equal to a provider run minus the block", async () => {
		const provider = createFixtureAuthoritativeProvider({
			rules: [{ matchOn: "example terrace", response: fixtureExactMatch() }],
		})

		const bare = await geocodeAddress(INPUT, testDeps())
		const withProvider = await geocodeAddress(INPUT, { ...testDeps(), authoritativeProvider: provider })

		expect(bare.authoritative).toBeUndefined()

		const { authoritative, ...rest } = withProvider

		expect(authoritative).toBeDefined()
		expect(rest).toEqual(bare)
	})

	it("the provider receives the assembled evidence: components, both query forms, and the resolved country", async () => {
		const log: AuthoritativeQuery[] = []
		const provider = createFixtureAuthoritativeProvider({ rules: [], log })

		await geocodeAddress(INPUT, { ...testDeps(), authoritativeProvider: provider })

		expect(log).toHaveLength(1)
		expect(log[0]!.rawQuery).toBe(INPUT)
		expect(log[0]!.normalizedQuery.length).toBeGreaterThan(0)
		expect(log[0]!.components).toContainEqual({ tag: "locality", value: "Testtown" })
		expect(log[0]!.components).toContainEqual({ tag: "postcode", value: "TT1 1TT" })
		expect(log[0]!.countryCode).toBe("GB")
	})
})
