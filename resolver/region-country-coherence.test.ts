/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for region-country coherence (`applyRegionCountryCoherence`, wired under `opts.adminCoherence`).
 *   When the locale-inferred `defaultCountry` is applied as a HARD `spr.country` candidate filter, a region
 *   qualifier naming a FOREIGN subdivision ("QC" under a US locale) resolves to nothing and is discarded —
 *   and the locality is force-matched to the populous US namesake ("Montreal" → Montreal, WI). This pass
 *   expands the region token to its country via codex's ISO-3166-2 subdivision table (QC → Quebec / CA),
 *   confirms both the subdivision and a same-named locality resolve UNDER that country, and swaps the pair.
 *
 *   Byte-stable on the domestic path: a US region resolves fine under `US`, so the "region unresolved"
 *   trigger never fires for "Springfield, IL" / "Portland, ME".
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

import { createWOFResolver } from "./resolve.ts"

// A test region carries an `abbrev` so the fake backend can model the 2-letter address-line code (the gazetteer
// resolves "IL" via an alt-name; here abbrev-match stands in). `country` gates it under the hard default-country filter.
interface RegionPlace extends ResolvedPlace {
	abbrev: string
}

const QUEBEC: RegionPlace = {
	id: 100,
	name: "Quebec",
	abbrev: "QC",
	placetype: "region",
	country: "CA",
	lat: 52.0,
	lon: -72.0,
	score: 9,
	exactMatch: true,
}
const ONTARIO: RegionPlace = {
	id: 101,
	name: "Ontario",
	abbrev: "ON",
	placetype: "region",
	country: "CA",
	lat: 50.0,
	lon: -85.0,
	score: 9,
	exactMatch: true,
}
const ILLINOIS: RegionPlace = {
	id: 102,
	name: "Illinois",
	abbrev: "IL",
	placetype: "region",
	country: "US",
	lat: 40.0,
	lon: -89.0,
	score: 9,
	exactMatch: true,
}
const MAINE: RegionPlace = {
	id: 103,
	name: "Maine",
	abbrev: "ME",
	placetype: "region",
	country: "US",
	lat: 45.3,
	lon: -69.0,
	score: 9,
	exactMatch: true,
}

// Montréal, Quebec (the populous, correct target) vs Montreal, WI (the US namesake the greedy US filter picks).
const MONTREAL_CA: ResolvedPlace = {
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
// London, Ontario vs London, KY (a real US namesake — so the greedy US filter DOES resolve a locality to rescue from).
const LONDON_CA: ResolvedPlace = {
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
// The domestic controls — a same-named US locality under its US region.
const SPRINGFIELD_IL: ResolvedPlace = {
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

/**
 * Backend filtered by name equality (regions also match their two-letter `abbrev`), placetype, country, and `parentID`
 * (descendant scope). Models the HARD `spr.country` filter: a query with `country` set never returns a foreign row.
 */
function makeBackend(places: ResolvedPlace[]): ResolverBackend {
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

// region(<region>) → locality(<city>), the shape the parser produces for "<city>, <region>".
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

function localityOf(tree: AddressTree): AddressNode | undefined {
	const stack = [...tree.roots]

	while (stack.length) {
		const n = stack.pop()!

		if (n.tag === "locality") return n
		stack.push(...n.children)
	}

	return undefined
}

function regionOf(tree: AddressTree): AddressNode | undefined {
	const stack = [...tree.roots]

	while (stack.length) {
		const n = stack.pop()!

		if (n.tag === "region") return n
		stack.push(...n.children)
	}

	return undefined
}

const CA_POOL = [QUEBEC, ONTARIO, ILLINOIS, MAINE, MONTREAL_CA, MONTREAL_WI, LONDON_CA, LONDON_KY]

describe("resolveTree + region-country coherence (Montreal QC)", () => {
	it("rescues 'Montreal QC' from the US namesake to Montréal, Quebec under a US default country", async () => {
		const resolver = createWOFResolver(makeBackend(CA_POOL))
		// defaultCountry US models the en-US locale hard filter that discards the "QC" region and picks Montreal WI.
		const out = await resolver.resolveTree(regionLocalityTree("Montreal", "QC"), { defaultCountry: "US" })
		const loc = localityOf(out)

		expect(loc?.lat).toBeCloseTo(45.5019, 3)
		expect(loc?.lon).toBeCloseTo(-73.5674, 3)
		expect(loc?.metadata?.["resolver_country"]).toBe("CA")
		expect(loc?.metadata?.["region_country_repicked"]).toBe(true)

		// The region node is re-decorated with Québec (the subdivision resolved under CA), not left as the dropped token.
		const region = regionOf(out)
		expect(region?.metadata?.["resolver_country"]).toBe("CA")
		expect(region?.metadata?.["region_country_repicked"]).toBe(true)
	})

	it("also rescues the region FULL NAME 'Montreal, Quebec' (no abbreviation needed)", async () => {
		const resolver = createWOFResolver(makeBackend(CA_POOL))
		const out = await resolver.resolveTree(regionLocalityTree("Montreal", "Quebec"), { defaultCountry: "US" })
		const loc = localityOf(out)

		expect(loc?.lat).toBeCloseTo(45.5019, 3)
		expect(loc?.metadata?.["resolver_country"]).toBe("CA")
		expect(loc?.metadata?.["region_country_repicked"]).toBe(true)
	})

	it("rescues 'London ON' to London, Ontario (generality — a second CA subdivision)", async () => {
		const resolver = createWOFResolver(makeBackend(CA_POOL))
		const out = await resolver.resolveTree(regionLocalityTree("London", "ON"), { defaultCountry: "US" })
		const loc = localityOf(out)

		expect(loc?.lat).toBeCloseTo(42.9834, 3)
		expect(loc?.metadata?.["resolver_country"]).toBe("CA")
		expect(loc?.metadata?.["region_country_repicked"]).toBe(true)
	})

	it("stays inert for the domestic control 'Springfield IL' (region resolves under US → trigger never fires)", async () => {
		const resolver = createWOFResolver(makeBackend([ILLINOIS, MAINE, QUEBEC, SPRINGFIELD_IL]))
		const out = await resolver.resolveTree(regionLocalityTree("Springfield", "IL"), { defaultCountry: "US" })
		const loc = localityOf(out)

		expect(loc?.lat).toBeCloseTo(39.7817, 3)
		expect(loc?.metadata?.["resolver_country"]).toBe("US")
		expect(loc?.metadata?.["region_country_repicked"]).toBeUndefined()
		const region = regionOf(out)
		expect(region?.metadata?.["resolver_country"]).toBe("US")
	})

	it("stays inert for the domestic control 'Portland ME'", async () => {
		const resolver = createWOFResolver(makeBackend([ILLINOIS, MAINE, QUEBEC, ONTARIO, PORTLAND_ME]))
		const out = await resolver.resolveTree(regionLocalityTree("Portland", "ME"), { defaultCountry: "US" })
		const loc = localityOf(out)

		expect(loc?.lat).toBeCloseTo(43.6591, 3)
		expect(loc?.metadata?.["resolver_country"]).toBe("US")
		expect(loc?.metadata?.["region_country_repicked"]).toBeUndefined()
	})

	it("does not fire without a default country (nothing was hard-filtered → nothing to rescue)", async () => {
		const resolver = createWOFResolver(makeBackend(CA_POOL))
		const out = await resolver.resolveTree(regionLocalityTree("Montreal", "QC"), {})
		const loc = localityOf(out)

		expect(loc?.metadata?.["region_country_repicked"]).toBeUndefined()
	})

	it("does not fire when adminCoherence is explicitly false (the opt-out)", async () => {
		const resolver = createWOFResolver(makeBackend(CA_POOL))
		const out = await resolver.resolveTree(regionLocalityTree("Montreal", "QC"), {
			defaultCountry: "US",
			adminCoherence: false,
		})
		const loc = localityOf(out)

		// Greedy US filter → Montreal WI, and no coherence re-pick.
		expect(loc?.metadata?.["region_country_repicked"]).toBeUndefined()
		expect(loc?.metadata?.["resolver_country"]).toBe("US")
	})

	it("keeps the greedy result when the foreign country has no same-named locality (fail-safe)", async () => {
		// Quebec resolves under CA, but there is NO 'Gotham' locality anywhere → no re-pick, region stays unresolved.
		const resolver = createWOFResolver(makeBackend([QUEBEC, ILLINOIS]))
		const out = await resolver.resolveTree(regionLocalityTree("Gotham", "QC"), { defaultCountry: "US" })
		const loc = localityOf(out)

		expect(loc?.metadata?.["region_country_repicked"]).toBeUndefined()
	})
})
