/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { walkNodes, type AddressNode, type AddressTree } from "@mailwoman/core/decoder"
import { EMPTY_PLACE_FIELDS } from "@mailwoman/core/resolver"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

import { createWOFResolver } from "#resolve"

interface RegionPlace extends ResolvedPlace {
	abbrev: string
}

const QUEBEC: RegionPlace = {
	...EMPTY_PLACE_FIELDS,
	id: 100,
	name: "Quebec",
	abbrev: "QC",
	placetype: "region",
	country: "CA",
	lat: 52,
	lon: -72,
	score: 9,
	exactMatch: true,
}

const ONTARIO: RegionPlace = {
	...EMPTY_PLACE_FIELDS,
	id: 101,
	name: "Ontario",
	abbrev: "ON",
	placetype: "region",
	country: "CA",
	lat: 50,
	lon: -85,
	score: 9,
	exactMatch: true,
}

const ILLINOIS: RegionPlace = {
	...EMPTY_PLACE_FIELDS,
	id: 102,
	name: "Illinois",
	abbrev: "IL",
	placetype: "region",
	country: "US",
	lat: 40,
	lon: -89,
	score: 9,
	exactMatch: true,
}

const MAINE: RegionPlace = {
	...EMPTY_PLACE_FIELDS,
	id: 103,
	name: "Maine",
	abbrev: "ME",
	placetype: "region",
	country: "US",
	lat: 45.3,
	lon: -69,
	score: 9,
	exactMatch: true,
}

const MONTREAL_CA: ResolvedPlace = {
	...EMPTY_PLACE_FIELDS,
	id: 200,
	name: "Montreal",
	placetype: "locality",
	country: "CA",
	parent_id: 100,
	lat: 45.5019,
	lon: -73.5674,
	score: 9,
	exactMatch: true,
}

const MONTREAL_WI: ResolvedPlace = {
	...EMPTY_PLACE_FIELDS,
	id: 201,
	name: "Montreal",
	placetype: "locality",
	country: "US",
	parent_id: 102,
	lat: 46.4312,
	lon: -90.2382,
	score: 6,
	exactMatch: true,
}

const LONDON_CA: ResolvedPlace = {
	...EMPTY_PLACE_FIELDS,
	id: 202,
	name: "London",
	placetype: "locality",
	country: "CA",
	parent_id: 101,
	lat: 42.9834,
	lon: -81.233,
	score: 9,
	exactMatch: true,
}

const LONDON_KY: ResolvedPlace = {
	...EMPTY_PLACE_FIELDS,
	id: 203,
	name: "London",
	placetype: "locality",
	country: "US",
	parent_id: 103,
	lat: 37.129,
	lon: -84.083,
	score: 5,
	exactMatch: true,
}

const SPRINGFIELD_IL: ResolvedPlace = {
	...EMPTY_PLACE_FIELDS,
	id: 204,
	name: "Springfield",
	placetype: "locality",
	country: "US",
	parent_id: 102,
	lat: 39.7817,
	lon: -89.6501,
	score: 9,
	exactMatch: true,
}

const PORTLAND_ME: ResolvedPlace = {
	...EMPTY_PLACE_FIELDS,
	id: 205,
	name: "Portland",
	placetype: "locality",
	country: "US",
	parent_id: 103,
	lat: 43.6591,
	lon: -70.2568,
	score: 9,
	exactMatch: true,
}

async function makeBackend(places: ResolvedPlace[]): Promise<ResolverBackend> {
	return {
		async findPlace(query) {
			const text = query.text.toLowerCase()
			const types = Array.isArray(query.placetype) ? query.placetype : query.placetype ? [query.placetype] : null

			return places
				.filter((p) => {
					if (p.name.toLowerCase() === text) return true
					const abbrev = (p as RegionPlace).abbrev

					return p.placetype === "region" && typeof abbrev === "string" && abbrev.toLowerCase() === text
				})
				.filter((p) => !types || types.includes(p.placetype))
				.filter((p) => !query.country || p.country === query.country)
				.filter((p) => query.parentID === undefined || p.parent_id === query.parentID)
				.slice(0, query.limit ?? 5)
		},
	}
}

const node = (over: Partial<AddressNode> & Pick<AddressNode, "tag" | "value" | "start" | "end">): AddressNode => ({
	confidence: 0.95,
	children: [],
	...over,
})

const regionLocalityTree = (city: string, region: string): AddressTree => ({
	raw: `${city}, ${region}`,
	roots: [
		node({
			tag: "region",
			value: region,
			start: city.length + 2,
			end: city.length + 2 + region.length,
			children: [node({ tag: "locality", value: city, start: 0, end: city.length })],
		}),
	],
})

function localityOf(tree: AddressTree): AddressNode | null {
	for (const n of walkNodes(tree.roots)) {
		if (n.tag === "locality") return n
	}

	return null
}

function regionOf(tree: AddressTree): AddressNode | null {
	for (const n of walkNodes(tree.roots)) {
		if (n.tag === "region") return n
	}

	return null
}

const CA_POOL = [QUEBEC, ONTARIO, ILLINOIS, MAINE, MONTREAL_CA, MONTREAL_WI, LONDON_CA, LONDON_KY]

describe("resolveTree + region-country coherence (Montreal QC)", () => {
	it("rescues 'Montreal QC' from the US namesake to Montréal, Quebec under a US default country", async () => {
		const resolver = createWOFResolver(await makeBackend(CA_POOL))

		const out = await resolver.resolveTree(regionLocalityTree("Montreal", "QC"), {
			defaultCountry: { country: "US", source: "caller" },
		})

		const loc = localityOf(out)

		expect(loc?.lat).toBeCloseTo(45.5019, 3)
		expect(loc?.lon).toBeCloseTo(-73.5674, 3)
		expect(loc?.metadata?.["resolver_country"]).toBe("CA")
		expect(loc?.metadata?.["region_country_repicked"]).toBe(true)

		const region = regionOf(out)
		expect(region?.metadata?.["resolver_country"]).toBe("CA")
		expect(region?.metadata?.["region_country_repicked"]).toBe(true)
	})

	it("also rescues the region FULL NAME 'Montreal, Quebec' (no abbreviation needed)", async () => {
		const resolver = createWOFResolver(await makeBackend(CA_POOL))

		const out = await resolver.resolveTree(regionLocalityTree("Montreal", "Quebec"), {
			defaultCountry: { country: "US", source: "caller" },
		})

		const loc = localityOf(out)

		expect(loc?.lat).toBeCloseTo(45.5019, 3)
		expect(loc?.metadata?.["resolver_country"]).toBe("CA")
		expect(loc?.metadata?.["region_country_repicked"]).toBe(true)
	})

	it("rescues 'London ON' to London, Ontario (generality — a second CA subdivision)", async () => {
		const resolver = createWOFResolver(await makeBackend(CA_POOL))

		const out = await resolver.resolveTree(regionLocalityTree("London", "ON"), {
			defaultCountry: { country: "US", source: "caller" },
		})

		const loc = localityOf(out)

		expect(loc?.lat).toBeCloseTo(42.9834, 3)
		expect(loc?.metadata?.["resolver_country"]).toBe("CA")
		expect(loc?.metadata?.["region_country_repicked"]).toBe(true)
	})

	it("stays inert for the domestic control 'Springfield IL' (region resolves under US → trigger never fires)", async () => {
		const resolver = createWOFResolver(await makeBackend([ILLINOIS, MAINE, QUEBEC, SPRINGFIELD_IL]))

		const out = await resolver.resolveTree(regionLocalityTree("Springfield", "IL"), {
			defaultCountry: { country: "US", source: "caller" },
		})

		const loc = localityOf(out)

		expect(loc?.lat).toBeCloseTo(39.7817, 3)
		expect(loc?.metadata?.["resolver_country"]).toBe("US")
		expect(loc?.metadata?.["region_country_repicked"]).toBeUndefined()
		const region = regionOf(out)
		expect(region?.metadata?.["resolver_country"]).toBe("US")
	})

	it("stays inert for the domestic control 'Portland ME'", async () => {
		const resolver = createWOFResolver(await makeBackend([ILLINOIS, MAINE, QUEBEC, ONTARIO, PORTLAND_ME]))

		const out = await resolver.resolveTree(regionLocalityTree("Portland", "ME"), {
			defaultCountry: { country: "US", source: "caller" },
		})

		const loc = localityOf(out)

		expect(loc?.lat).toBeCloseTo(43.6591, 3)
		expect(loc?.metadata?.["resolver_country"]).toBe("US")
		expect(loc?.metadata?.["region_country_repicked"]).toBeUndefined()
	})

	it("does not fire without a default country (nothing was hard-filtered → nothing to rescue)", async () => {
		const resolver = createWOFResolver(await makeBackend(CA_POOL))
		const out = await resolver.resolveTree(regionLocalityTree("Montreal", "QC"), {})
		const loc = localityOf(out)

		expect(loc?.metadata?.["region_country_repicked"]).toBeUndefined()
	})

	it("does not fire when adminCoherence is explicitly false (the opt-out)", async () => {
		const resolver = createWOFResolver(await makeBackend(CA_POOL))

		const out = await resolver.resolveTree(regionLocalityTree("Montreal", "QC"), {
			defaultCountry: { country: "US", source: "caller" },
			adminCoherence: false,
		})

		const loc = localityOf(out)

		expect(loc?.metadata?.["region_country_repicked"]).toBeUndefined()
		expect(loc?.metadata?.["resolver_country"]).toBe("US")
	})

	it("keeps the greedy result when the foreign country has no same-named locality (fail-safe)", async () => {
		const resolver = createWOFResolver(await makeBackend([QUEBEC, ILLINOIS]))

		const out = await resolver.resolveTree(regionLocalityTree("Gotham", "QC"), {
			defaultCountry: { country: "US", source: "caller" },
		})

		const loc = localityOf(out)

		expect(loc?.metadata?.["region_country_repicked"]).toBeUndefined()
	})
})
