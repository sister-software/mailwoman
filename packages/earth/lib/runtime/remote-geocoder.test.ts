/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { GeocodeResponse } from "@mailwoman/api/operations/geocode/address"
import type { AddressTree } from "@mailwoman/core/decoder"
import { tryParsingJSON } from "@mailwoman/core/json"
import { afterEach, describe, expect, it, vi } from "vitest"

import { candidatesFromGeocode, RemoteGeocoderError, remoteGeocode } from "#runtime/remote-geocoder"

const API = new URL("https://api.test/")

const TREE: AddressTree = {
	raw: "Springfield",
	roots: [{ tag: "locality", value: "Springfield", start: 0, end: 11, confidence: 0.97, children: [] }],
}

/**
 * A geocode response for `Springfield` that resolved the Illinois city, with Massachusetts as the runner-up.
 */
function springfield(overrides: Partial<GeocodeResponse> = {}): GeocodeResponse {
	return {
		input: "Springfield",
		components: { locality: "Springfield" },
		dropped_components: null,
		unfollowed_components: null,
		lat: 39.7817,
		lon: -89.6501,
		resolution_tier: "locality",
		epistemic_status: "designated",
		derivation: null,
		entity: null,
		rooftop: null,
		coordinate_source: null,
		uncertainty_m: null,
		locality: "Springfield",
		region: null,
		postcode: null,
		house_number: null,
		street: null,
		venue: null,
		dependent_locality: null,
		unit: null,
		countryCode: "US",
		hierarchy: [],
		candidates: [
			{
				name: "Springfield",
				tag: "locality",
				lat: 39.7817,
				lon: -89.6501,
				countryCode: "US",
				placeID: "wof:85940429",
				score: 6.3,
			},
			{
				name: "Springfield",
				tag: "locality",
				lat: 42.1015,
				lon: -72.5898,
				countryCode: "US",
				placeID: "wof:85950361",
				score: null,
			},
		],
		postcode_country_scope: null,
		capital_promotion: null,
		variant_alias_exemption: "not_applied",
		intent_markers: [],
		admin_coherence: null,
		authoritative: null,
		tree: TREE,
		...overrides,
	} as GeocodeResponse
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("remoteGeocode", () => {
	it("sends one geocode request with the bias and the tree option, and renders spans from the returned tree", async () => {
		const requests: Array<{ url: string; body: unknown }> = []

		vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
			requests.push({ url: url.toString(), body: tryParsingJSON(String(init.body)) })

			return Response.json(springfield())
		})

		const bias = [{ lat: 42.1, lon: -72.6, weight: 1 }]
		const { result } = await remoteGeocode(API, "Springfield", bias, { onStage: () => {} })

		expect(requests).toEqual([
			{ url: "https://api.test/v1/geocode", body: { address: "Springfield", bias, include_tree: true } },
		])

		expect(result.nodes).toEqual([{ tag: "locality", value: "Springfield", confidence: 0.97, start: 0, end: 11 }])
		expect(result.resolved?.name).toBe("Springfield")
	})

	it("refuses a response that omits the requested tree", async () => {
		vi.stubGlobal("fetch", async () => Response.json(springfield({ tree: null })))

		await expect(remoteGeocode(API, "Springfield", [], { onStage: () => {} })).rejects.toBeInstanceOf(
			RemoteGeocoderError
		)
	})
})

describe("candidatesFromGeocode", () => {
	it("keeps each candidate's resolver score and leaves an unscored runner-up null", () => {
		expect(candidatesFromGeocode(springfield()).map((candidate) => [candidate.id, candidate.score])).toEqual([
			[85_940_429, 6.3],
			[85_950_361, null],
		])
	})

	it("scores a street-tier answer null, because the gazetteer did not rank its point", () => {
		const [answer] = candidatesFromGeocode(
			springfield({
				resolution_tier: "address_point",
				house_number: "1",
				street: "Main St",
				lat: 39.8,
				lon: -89.64,
			})
		)

		expect(answer).toMatchObject({ id: 0, name: "1 Main St", score: null, tier: "address_point" })
	})
})
