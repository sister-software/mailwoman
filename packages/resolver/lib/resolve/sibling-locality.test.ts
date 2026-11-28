// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { EMPTY_PLACE_FIELDS, type ResolvedPlace, type ResolverBackend } from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

import { createWOFResolver } from "#resolve"

const LONDON_ID = 101_750_367
const KENSINGTON_GB_ID = 1_158_859_439
const KENSINGTON_US_ID = 85_925_131

const place = (id: number, name: string, country: string, prominence: number): ResolvedPlace => ({
	...EMPTY_PLACE_FIELDS,
	id,
	name,
	placetype: "locality",
	country,
	lat: country === "GB" ? 51.5 : 37.9,
	lon: country === "GB" ? -0.19 : -122.28,
	score: prominence,
	prominence,
	exactMatch: true,
})

const LONDON = place(LONDON_ID, "London", "GB", 6.9)
const KENSINGTON_US = place(KENSINGTON_US_ID, "Kensington", "US", 3.7)
const KENSINGTON_GB = place(KENSINGTON_GB_ID, "Kensington", "GB", 0)

/**
 * A backend that marks containment only for the lookup qualified by London, as the ancestors sidecar does.
 */
const backend: ResolverBackend = {
	async findPlace(query) {
		if (query.placetype !== "locality") return []

		if (query.text === "London") {
			return [{ ...LONDON, containedByQualifier: query.parentQualifierID != null ? false : null }]
		}

		if (query.text !== "Kensington") return []

		if (query.parentQualifierID === LONDON_ID) {
			return [
				{ ...KENSINGTON_GB, containedByQualifier: true },
				{ ...KENSINGTON_US, containedByQualifier: false },
			].filter((c) => !query.country || c.country === query.country)
		}

		return [{ ...KENSINGTON_US }]
	},
}

const locality = (value: string, start: number): AddressNode => ({
	tag: "locality",
	value,
	start,
	end: start + value.length,
	confidence: 0.9,
	children: [],
})

const treeOf = (...values: string[]): AddressTree => {
	let start = 0
	const roots: AddressNode[] = []

	for (const value of values) {
		roots.push(locality(value, start))
		start += value.length + 2
	}

	return { raw: values.join(", "), roots }
}

describe("sibling-locality containment", () => {
	it("resolves the inner locality inside the outer one, and leaves it apart when off", async () => {
		const resolver = createWOFResolver(backend)
		const off = await resolver.resolveTree(treeOf("Kensington", "London"), { siblingLocalityContainment: false })
		const on = await resolver.resolveTree(treeOf("Kensington", "London"), { siblingLocalityContainment: true })

		expect(off.roots[0]?.placeID).toBe(`wof:${KENSINGTON_US_ID}`)

		expect(on.roots[0]).toMatchObject({ tag: "dependent_locality", placeID: `wof:${KENSINGTON_GB_ID}` })
		expect(on.roots[0]?.metadata?.["contained_by_parent"]).toBe(true)
		expect(on.roots[1]).toMatchObject({ tag: "locality", placeID: `wof:${LONDON_ID}` })
	})

	it("orders the spans by the gazetteer's containment, not by token position", async () => {
		const out = await createWOFResolver(backend).resolveTree(treeOf("London", "Kensington"), {
			siblingLocalityContainment: true,
		})

		expect(out.roots[0]).toMatchObject({ tag: "locality", placeID: `wof:${LONDON_ID}` })
		expect(out.roots[1]).toMatchObject({ tag: "dependent_locality", placeID: `wof:${KENSINGTON_GB_ID}` })
	})
})
