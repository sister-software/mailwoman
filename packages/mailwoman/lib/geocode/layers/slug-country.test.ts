// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Tests that `regionSubdivisionOfTree` reads a tree's region against the country the resolver placed it in.
 *
 *   The ISO 3166-2 code selects a region's street databases. Some region codes two countries share
 *   (Italian "MI", Australian "WA") would otherwise select another country's region.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { describe, expect, it } from "vitest"

import { regionSubdivisionOfTree } from "#geocode"

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

describe("regionSubdivisionOfTree country check", () => {
	it("yields the code of a region in the resolved country, from its code or its name", () => {
		expect(regionSubdivisionOfTree(tree("MI", "US"))).toBe("US-MI")
		expect(regionSubdivisionOfTree(tree("Michigan", "US"))).toBe("US-MI")
		expect(regionSubdivisionOfTree(tree("New York", "us"))).toBe("US-NY")
		expect(regionSubdivisionOfTree(tree("ON", "CA"))).toBe("CA-ON")
		expect(regionSubdivisionOfTree(tree("WA", "AU"))).toBe("AU-WA")
	})

	it("never yields another country's region for a code two countries share", () => {
		// Each region code is a United States state's when the country is left out.
		for (const [region, country] of [
			["MI", "IT"],
			["CO", "IT"],
			["PA", "IT"],
			["CA", "ES"],
			["MA", "ES"],
			["WA", "AU"],
			["SC", "BR"],
		] as const) {
			expect(regionSubdivisionOfTree(tree(region))).toBe(`US-${region}`)
			expect(regionSubdivisionOfTree(tree(region, country))).not.toBe(`US-${region}`)
		}
	})

	it("still yields a code when the country is unknown", () => {
		// An address whose country never resolved still needs its street-tier database.
		expect(regionSubdivisionOfTree(tree("MI"))).toBe("US-MI")
		expect(regionSubdivisionOfTree(tree("TX"))).toBe("US-TX")
	})

	it("reads the country off any node, and the region's own node need not state it", () => {
		const t: AddressTree = {
			raw: "Via Roma 12, 20121 Milano MI",
			roots: [
				node({ tag: "street", value: "Via Roma" }),
				node({ tag: "region", value: "MI" }),
				node({ tag: "postcode", value: "20121", metadata: { resolver_country: "IT" } }),
			],
		}

		expect(regionSubdivisionOfTree(t)).toBeNull()
	})

	it("reads the resolved name only when the region's value isn't a two-letter code", () => {
		const named = (value: string): AddressTree => ({
			raw: value,
			roots: [node({ tag: "region", value, metadata: { resolver_name: "Kentucky" } })],
		})

		expect(regionSubdivisionOfTree(named("Bluegrass State"))).toBe("US-KY")
		expect(regionSubdivisionOfTree(named("ZZ"))).toBeNull()
	})

	it("returns null for a tree with no region at all", () => {
		expect(regionSubdivisionOfTree({ raw: "", roots: [] })).toBeNull()
		expect(regionSubdivisionOfTree({ raw: "x", roots: [node({ tag: "locality", value: "x" })] })).toBeNull()
	})
})
