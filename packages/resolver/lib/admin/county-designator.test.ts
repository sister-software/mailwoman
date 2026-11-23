// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The county-designator fallback: a `locality` span written as a county answers its own region's county,
 *   never a namesake county in another region, and never when the region holds a locality of that name.
 */

import { expandPlacetypeFilter } from "@mailwoman/codex/labels/placetype-map"
import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { EMPTY_PLACE_FIELDS } from "@mailwoman/core/resolver"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

import { countyFromDesignatedLocality } from "#admin/county-designator"
import { createWOFResolver } from "#index"

const TEXAS = 10
const GEORGIA = 20

const PLACES: ResolvedPlace[] = [
	{ ...EMPTY_PLACE_FIELDS, id: TEXAS, name: "TX", placetype: "region", country: "US", lat: 31, lon: -98, score: 9 },
	{ ...EMPTY_PLACE_FIELDS, id: GEORGIA, name: "GA", placetype: "region", country: "US", lat: 32, lon: -83, score: 9 },
	{
		...EMPTY_PLACE_FIELDS,
		id: 101,
		name: "Harris",
		placetype: "county",
		country: "US",
		parent_id: TEXAS,
		lat: 29.85,
		lon: -95.45,
		score: 5,
	},
	// The namesake county in another region, better scored: an unscoped probe would take it.
	{
		...EMPTY_PLACE_FIELDS,
		id: 102,
		name: "Harris",
		placetype: "county",
		country: "US",
		parent_id: GEORGIA,
		lat: 32.73,
		lon: -84.9,
		score: 6,
	},
	// A locality spelled with the designator, outside Texas.
	{
		...EMPTY_PLACE_FIELDS,
		id: 201,
		name: "Harris County",
		placetype: "locality",
		country: "US",
		parent_id: GEORGIA,
		lat: 32.7,
		lon: -84.8,
		score: 2,
	},
]

const REGION_OF: Record<string, number> = { TX: TEXAS, GA: GEORGIA }

/**
 * Matches by exact name, scopes by `parentID`, and stamps containment in the written region qualifier.
 */
class FakeBackend implements ResolverBackend {
	readonly calls: Array<Parameters<ResolverBackend["findPlace"]>[0]> = []

	readonly places: readonly ResolvedPlace[]

	constructor(places: readonly ResolvedPlace[]) {
		this.places = places
	}

	async findPlace(query: Parameters<ResolverBackend["findPlace"]>[0]): Promise<ResolvedPlace[]> {
		this.calls.push(query)
		const requested = Array.isArray(query.placetype) ? query.placetype : query.placetype ? [query.placetype] : null
		const types = expandPlacetypeFilter(requested)
		const qualifier = query.regionQualifier ? REGION_OF[query.regionQualifier] : undefined

		return this.places
			.filter((p) => p.name === query.text)
			.filter((p) => !types || types.includes(p.placetype))
			.filter((p) => !query.parentID || p.parent_id === query.parentID)
			.map((p) => ({
				...p,
				exactMatch: true,
				...(query.regionQualifier ? { containedByQualifier: p.parent_id === qualifier } : {}),
			}))
			.toSorted((a, b) => b.score - a.score)
			.slice(0, query.limit ?? 5)
	}
}

function node(tag: string, value: string): AddressNode {
	return { tag: tag as AddressNode["tag"], value, start: 0, end: value.length, confidence: 1, children: [] }
}

async function resolveLocality(places: readonly ResolvedPlace[], value: string, countyDesignatorFallback: boolean) {
	const tree: AddressTree = { raw: `${value}, TX`, roots: [node("region", "TX"), node("locality", value)] }

	const resolved = await createWOFResolver(new FakeBackend(places)).resolveTree(tree, {
		defaultCountry: { country: "US", source: "inferred" },
		countyDesignatorFallback,
	})

	return resolved.roots[1]!
}

describe("county-designator fallback", () => {
	it("answers the region's county and retags the span subregion", async () => {
		const county = await resolveLocality(PLACES, "Harris County", true)

		expect(county.tag).toBe("subregion")
		expect(county.placeID).toBe("wof:101")
		expect(county.metadata?.["county_designator_fallback"]).toBe(true)
	})

	it("leaves the span as the walk resolved it when the switch is off", async () => {
		const locality = await resolveLocality(PLACES, "Harris County", false)

		expect(locality.tag).toBe("locality")
		expect(locality.placeID).not.toBe("wof:101")
	})

	it("keeps a locality of that name inside the region", async () => {
		const inTexas: ResolvedPlace = { ...PLACES[4]!, id: 202, parent_id: TEXAS }
		const locality = await resolveLocality([...PLACES, inTexas], "Harris County", true)

		expect(locality.tag).toBe("locality")
		expect(locality.placeID).toBe("wof:202")
	})

	it("does not probe in a country whose written county is a WOF region (IE)", async () => {
		// WOF IE holds the county Cork as a region and the local authority Cork as a county.
		const backend = new FakeBackend([
			{
				...EMPTY_PLACE_FIELDS,
				id: 301,
				name: "Cork",
				placetype: "county",
				country: "IE",
				parent_id: 30,
				lat: 51.9,
				lon: -8.5,
				score: 5,
			},
		])

		const county = await countyFromDesignatedLocality(backend, "Co. Cork", {
			country: "IE",
			regionID: 30,
			regionQualifier: null,
			limit: 5,
		})

		expect(county).toBeNull()
		expect(backend.calls).toEqual([])
	})

	it("does not fire on a value without its country's designator", async () => {
		const locality = await resolveLocality(PLACES, "Harris", true)

		expect(locality.tag).toBe("locality")
		expect(locality.metadata?.["county_designator_fallback"]).toBeUndefined()
	})
})
