/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file #1787 — a state slug names a US database, so a tree the resolver placed elsewhere must not produce one.
 *
 *   `regionToStateSlug` accepts ANY two-letter region, and the rooftop databases are `address-points-us-<slug>.db`. Eight
 *   of sixteen Italian province codes reach a real US database that way, five of five Spanish, six of twelve Brazilian,
 *   and Australia's WA→Washington. Nothing wrong comes back today only because Milano's 20xxx does not collide with
 *   Michigan's 48xxx, which is a coincidence of numbering rather than a guarantee.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { regionSlugFromTree, regionToStateSlug } from "mailwoman/geocode-regions"
import { describe, expect, it } from "vitest"

const node = (over: Partial<AddressNode> & Pick<AddressNode, "tag" | "value">): AddressNode => ({
	start: 0,
	end: over.value.length,
	confidence: 0.9,
	children: [],
	...over,
})

/**
 * A tree carrying a region span and, optionally, the country the resolver placed it in.
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

describe("regionSlugFromTree country gate", () => {
	it("still yields a slug for a US tree, in both registers", () => {
		expect(regionSlugFromTree(tree("MI", "US"))).toBe("mi")
		expect(regionSlugFromTree(tree("Michigan", "US"))).toBe("mi")
		expect(regionSlugFromTree(tree("New York", "us"))).toBe("ny")
	})

	it("yields NOTHING for a tree the resolver placed outside the US", () => {
		// Every one of these selects a real database on disk without the gate.
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
		// Dropping it here would take the street tier from every US address whose country never resolved — the failure
		// this gate exists to avoid, not to cause.
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

	it("returns null for a tree with no region at all, gate or no gate", () => {
		expect(regionSlugFromTree({ raw: "", roots: [] })).toBeNull()
		expect(regionSlugFromTree({ raw: "x", roots: [node({ tag: "locality", value: "x" })] })).toBeNull()
	})
})
