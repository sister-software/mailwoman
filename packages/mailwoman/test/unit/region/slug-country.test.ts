/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests that `regionSlugFromTree` yields a US state slug only for trees the resolver did not place outside the US.
 *
 *   The slug selects an `address-points-us-<slug>.db` database, and many non-US region codes (Italian "MI", Australian
 *   "WA") collide with US state codes.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { regionSlugFromTree, regionToStateSlug } from "mailwoman/geocode"
import { describe, expect, it } from "vitest"

const node = (over: Partial<AddressNode> & Pick<AddressNode, "tag" | "value">): AddressNode => ({
	start: 0,
	end: over.value.length,
	confidence: 0.9,
	children: [],
	...over,
})

/**
 * Builds a tree with a region span and an optional resolver country.
 */
const tree = (region: string, country?: string): AddressTree => ({
	raw: region,
	roots: [
		node({
			tag: "locality",
			value: "somewhere",
			...(country ? { metadata: { resolver_country: country } } : {}),
			children: [node({ tag: "region", value: region })],
		}),
	],
})

describe("regionSlugFromTree country check", () => {
	it("still yields a slug for a US tree, in both registers", () => {
		expect(regionSlugFromTree(tree("MI", "US"))).toBe("mi")
		expect(regionSlugFromTree(tree("Michigan", "US"))).toBe("mi")
		expect(regionSlugFromTree(tree("New York", "us"))).toBe("ny")
	})

	it("yields NOTHING for a tree the resolver placed outside the US", () => {
		// Each region code maps to a real US state slug when the country is ignored.
		for (const [region, country] of [
			["MI", "IT"],
			["CO", "IT"],
			["PA", "IT"],
			["CA", "ES"],
			["MA", "ES"],
			["WA", "AU"],
			["SC", "BR"],
		] as const) {
			expect(regionToStateSlug(region, null)).not.toBeNull()
			expect(regionSlugFromTree(tree(region, country))).toBeNull()
		}
	})

	it("still yields a slug when the country is UNKNOWN", () => {
		// A US address whose country never resolved still needs its street-tier database.
		expect(regionSlugFromTree(tree("MI"))).toBe("mi")
		expect(regionSlugFromTree(tree("TX"))).toBe("tx")
	})

	it("reads the country off any node, not only the one carrying the region", () => {
		const t: AddressTree = {
			raw: "Via Roma 12, 20121 Milano MI",
			roots: [
				node({ tag: "street", value: "Via Roma" }),
				node({ tag: "region", value: "MI" }),
				node({ tag: "postcode", value: "20121", metadata: { resolver_country: "IT" } }),
			],
		}

		expect(regionSlugFromTree(t)).toBeNull()
	})

	it("returns null for a tree with no region at all, check or no check", () => {
		expect(regionSlugFromTree({ raw: "", roots: [] })).toBeNull()
		expect(regionSlugFromTree({ raw: "x", roots: [node({ tag: "locality", value: "x" })] })).toBeNull()
	})
})
