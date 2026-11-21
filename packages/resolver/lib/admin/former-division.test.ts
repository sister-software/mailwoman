// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The former-division acceptance: a `subregion` no current division answers is accepted only when a
 *   former division of that name covered the resolved locality, and it never scopes or moves the locality.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { EMPTY_PLACE_FIELDS } from "@mailwoman/core/resolver"
import type { Ancestor, FormerDivisionLookup, ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

import { FORMER_DIVISION } from "#admin/former-division"
import { createWOFResolver } from "#index"

const BRISTOL_COUNTY = 1_360_698_747
const BRISTOL = 1_175_612_699
const BATH = 101_750_367

const PLACES: ResolvedPlace[] = [
	{
		...EMPTY_PLACE_FIELDS,
		id: BRISTOL,
		name: "Bristol",
		placetype: "locality",
		country: "GB",
		lat: 51.45,
		lon: -2.58,
		score: 9,
	},
	{
		...EMPTY_PLACE_FIELDS,
		id: BATH,
		name: "Bath",
		placetype: "locality",
		country: "GB",
		lat: 51.38,
		lon: -2.36,
		score: 8,
	},
]

const ANCESTORS: Record<number, Ancestor[]> = {
	[BRISTOL]: [{ id: BRISTOL_COUNTY, placetype: "county", name: "Bristol" }],
	[BATH]: [{ id: 1_360_698_775, placetype: "county", name: "Bath and North East Somerset" }],
}

class FakeBackend implements ResolverBackend {
	async findPlace(query: Parameters<ResolverBackend["findPlace"]>[0]): Promise<ResolvedPlace[]> {
		return PLACES.filter((p) => p.name === query.text && (!query.placetype || query.placetype === p.placetype)).map(
			(p) => ({ ...p, exactMatch: true })
		)
	}

	ancestors(id: number | string): Ancestor[] {
		return ANCESTORS[Number(id)] ?? []
	}
}

/**
 * Avon, linked to the Bristol county record only, so Bath stands in for a place it never covered.
 */
const LOOKUP: FormerDivisionLookup = {
	divisionsNamed: (value, country) =>
		value === "Avon" && (country == null || country === "GB")
			? [
					{
						name: "Avon",
						country: "GB",
						kind: "county",
						tag: "subregion",
						geonamesID: 2_656_749,
						wofID: 9_895_008_294,
						linkedIDs: new Set([BRISTOL_COUNTY]),
						evidence: ["wof_supersession"],
					},
				]
			: [],
}

function node(tag: string, value: string): AddressNode {
	return { tag: tag as AddressNode["tag"], value, start: 0, end: value.length, confidence: 1, children: [] }
}

async function resolve(locality: string, formerDivisions: boolean) {
	const tree: AddressTree = { raw: `Avon, ${locality}`, roots: [node("subregion", "Avon"), node("locality", locality)] }

	const resolved = await createWOFResolver(new FakeBackend()).resolveTree(tree, {
		defaultCountry: { country: "GB", source: "inferred" },
		formerDivisions,
		formerDivisionLookup: LOOKUP,
	})

	return { division: resolved.roots[0]!, locality: resolved.roots[1]! }
}

describe("former-division acceptance", () => {
	it("accepts a former division linked to the resolved locality, and keeps no place for it", async () => {
		const { division, locality } = await resolve("Bristol", true)

		expect(division.placeID ?? null).toBeNull()

		expect(division.metadata?.[FORMER_DIVISION]).toMatchObject({
			name: "Avon",
			geonames_id: 2_656_749,
			linked_place: `wof:${BRISTOL}`,
			linked_id: BRISTOL_COUNTY,
		})

		expect(locality.placeID).toBe(`wof:${BRISTOL}`)
	})

	it("leaves a former division the locality's lineage doesn't hold unstamped", async () => {
		const { division, locality } = await resolve("Bath", true)

		expect(division.metadata?.[FORMER_DIVISION]).toBeUndefined()
		expect(locality.placeID).toBe(`wof:${BATH}`)
	})

	it("does nothing with the switch off", async () => {
		const { division } = await resolve("Bristol", false)

		expect(division.metadata?.[FORMER_DIVISION]).toBeUndefined()
	})
})
