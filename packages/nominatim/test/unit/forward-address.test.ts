/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The forward address block reads the JP tiers into Nominatim's keys from the resolved ancestry, and leaves a
 *   slot the parse filled alone.
 */

import { forwardToResolved } from "@mailwoman/nominatim/forward-address"
import type { GeocodeResult } from "mailwoman/geocode"
import { describe, expect, it } from "vitest"

function result(partial: Partial<GeocodeResult>): GeocodeResult {
	return {
		input: "",
		components: {},
		lat: 31.732839,
		lon: 131.083374,
		resolution_tier: "admin",
		locality: null,
		region: null,
		postcode: null,
		hierarchy: [],
		...partial,
	} as GeocodeResult
}

describe("forwardToResolved", () => {
	it("labels a JP result's municipality as city and prefecture as state from the hierarchy", () => {
		const r = result({
			input: "〒885-0061 宮崎県都城市下長飯町1867-2",
			postcode: "885-0061",
			hierarchy: [
				{ tag: "municipality", value: "都城市", name: "Miyakonojō", lat: 31.732839, lon: 131.083374 },
				{ tag: "prefecture", value: "宮崎県", name: "Miyazaki", lat: 32.277512, lon: 131.337844 },
			] as GeocodeResult["hierarchy"],
		})

		const resolved = forwardToResolved(r)

		expect(resolved.address).toEqual({ city: "Miyakonojō", state: "Miyazaki", postcode: "885-0061" })
		expect(resolved.displayName).toBe("Miyakonojō, Miyazaki, 885-0061")
	})

	it("keeps the parse's own slot over the ancestry, and takes the first name per key", () => {
		const r = result({
			locality: "London",
			region: "England",
			hierarchy: [
				{ tag: "dependent_locality", value: "Nine Elms", name: "Nine Elms" },
				{ tag: "locality", value: "London", name: "Greater London" },
				{ tag: "country", value: "United Kingdom", name: "United Kingdom" },
			] as GeocodeResult["hierarchy"],
		})

		expect(forwardToResolved(r).address).toEqual({
			city: "London",
			state: "England",
			suburb: "Nine Elms",
			country: "United Kingdom",
		})
	})
})
