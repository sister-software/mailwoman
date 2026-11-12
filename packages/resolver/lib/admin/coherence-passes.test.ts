// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { AddressNode } from "@mailwoman/core/decoder"
import { EMPTY_PLACE_FIELDS } from "@mailwoman/core/resolver"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

import { applyExplicitCountryCoherence } from "#admin/coherence-passes"
import { decorateNode } from "#decorate-node"

const place = (over: Partial<ResolvedPlace> & Pick<ResolvedPlace, "id" | "name" | "country">): ResolvedPlace => ({
	...EMPTY_PLACE_FIELDS,
	placetype: "locality",
	lat: 1,
	lon: 1,
	score: 1,
	exactMatch: true,
	...over,
})

/**
 * A backend whose every locality query in the requested country answers `answer`.
 */
const countryBackend = (answer: ResolvedPlace, seen: string[] = []): ResolverBackend => ({
	async findPlace(query) {
		seen.push(`${query.text}:${query.country}`)

		return query.country === answer.country ? [answer] : []
	},
})

/**
 * A country node wrapping one resolved place node, the tree shape the pass visits.
 */
const countryTree = (country: string, child: AddressNode): AddressNode[] => [
	{ tag: "country", value: country, start: 0, end: country.length, confidence: 0.9, children: [child] },
]

const resolvedNode = (tag: AddressNode["tag"], value: string, resolved: ResolvedPlace): AddressNode => {
	const node: AddressNode = { tag, value, start: 0, end: value.length, confidence: 0.9, children: [] }

	decorateNode(node, resolved, [])

	return node
}

describe("applyExplicitCountryCoherence", () => {
	it("keeps a dependent locality already resolved inside the written country (#2990)", async () => {
		// The walk placed King's Cross in its London neighborhood.
		// A locality-only query in GB answers the same-name locality on the Isle of Arran.
		const neighborhood = place({ id: 85_861_711, name: "King's Cross", country: "GB", placetype: "neighbourhood" })
		const arran = place({ id: 1_125_788_259, name: "Kings Cross", country: "GB", lat: 55.521834, lon: -5.078258 })
		const district = resolvedNode("dependent_locality", "King's Cross", neighborhood)

		await applyExplicitCountryCoherence(countryTree("United Kingdom", district), countryBackend(arran))

		expect(district.placeID).toBe("wof:85861711")
		expect(district.metadata?.["explicit_country_repicked"]).toBeUndefined()
	})

	it("re-picks a locality resolved outside the written country", async () => {
		const usBeirut = place({ id: 1, name: "Beirut", country: "US" })
		const lebanonBeirut = place({ id: 2, name: "Beirut", country: "LB", lat: 33.89, lon: 35.5 })
		const locality = resolvedNode("locality", "Beirut", usBeirut)

		await applyExplicitCountryCoherence(countryTree("Lebanon", locality), countryBackend(lebanonBeirut))

		expect(locality.placeID).toBe("wof:2")
		expect(locality.metadata?.["explicit_country_repicked"]).toBe(true)
	})

	it("resolves an unresolved locality inside the written country", async () => {
		const seen: string[] = []
		const lebanonBeirut = place({ id: 2, name: "Beirut", country: "LB", lat: 33.89, lon: 35.5 })
		const locality: AddressNode = { tag: "locality", value: "Beirut", start: 0, end: 6, confidence: 0.9, children: [] }

		await applyExplicitCountryCoherence(countryTree("Lebanon", locality), countryBackend(lebanonBeirut, seen))

		expect(seen).toEqual(["Beirut:LB"])
		expect(locality.placeID).toBe("wof:2")
	})
})
