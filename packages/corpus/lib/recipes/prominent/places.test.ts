// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file `prominent-places` — the #3156 label policy on the rows the recipe writes.
 *
 *   A sub-locality is written as a dependent locality only beside its parent locality, and in no other
 *   form while its postal reading is unresolved. Every row aligns.
 */

import { describe, expect, it } from "vitest"

import { prominentPlacesRecipe, prominentPlaceTag, type ProminentPlaceTuple } from "#recipes/prominent/places"
import { recipeRunner } from "#test-kit/corpus-recipe"

const run = recipeRunner("prominent-places", prominentPlacesRecipe, 3156)

const everyShape = { bare: 2, parent: 2, region: 2, region_abbr: 2, country: 2 }

const brooklyn: ProminentPlaceTuple = {
	spr_id: 421_205_765,
	country: "US",
	band: "sublocality",
	name: "Brooklyn",
	parent_locality: "New York",
	region: "New York",
	region_abbrs: ["NY"],
	country_name: "United States",
	rows: everyShape,
}

const kensington: ProminentPlaceTuple = {
	spr_id: 1_158_859_439,
	country: "GB",
	band: "sublocality",
	name: "Kensington",
	parent_locality: "London",
	region: "England",
	region_abbrs: [],
	country_name: "United Kingdom",
	rows: everyShape,
}

const lyon: ProminentPlaceTuple = {
	spr_id: 101_751_119,
	country: "FR",
	band: "locality",
	name: "Lyon",
	parent_locality: null,
	region: "Auvergne-Rhône-Alpes",
	region_abbrs: ["ARA"],
	country_name: "France",
	rows: { bare: 3, region: 1, region_abbr: 1, country: 4 },
}

describe("the #3156 label policy", () => {
	it("writes a locality in every shape but the parent's, and a sub-locality only beside its parent", () => {
		expect(prominentPlaceTag("locality", "region_abbr")).toBe("locality")
		expect(prominentPlaceTag("locality", "parent")).toBeNull()
		expect(prominentPlaceTag("sublocality", "parent")).toBe("dependent_locality")

		for (const shape of ["bare", "region", "region_abbr", "country"] as const) {
			expect(prominentPlaceTag("sublocality", shape)).toBeNull()
		}
	})
})

describe("prominent-places recipe", () => {
	it("writes every sub-locality beside its locality and in no other form", async () => {
		const { rows } = await run([brooklyn, kensington], [])

		expect(rows.map((row) => row.raw).toSorted()).toEqual(
			["Brooklyn, New York", "Kensington, London", "KENSINGTON, LONDON", "BROOKLYN, NEW YORK"].toSorted()
		)

		expect(rows.every((row) => row.components?.["dependent_locality"] && row.components["locality"])).toBe(true)
	})

	it("writes each shape's count, cycling case forms, with a source id per row", async () => {
		const { rows, stats } = await run([lyon], [])

		expect(rows).toHaveLength(9)
		expect(stats).toMatchObject({ read: 1, emitted: 9, skipped: 0 })

		expect(rows.filter((row) => row.raw.toLowerCase() === "lyon").map((row) => row.raw)).toEqual([
			"Lyon",
			"LYON",
			"lyon",
		])

		expect(new Set(rows.map((row) => row.source_id)).size).toBe(rows.length)
		// A country takes three characters or more, so no row ends in a two-letter code.
		const countries = rows.map((row) => row.components?.["country"]).filter((country) => country != null)

		expect(countries.length).toBeGreaterThan(0)
		expect(countries.every((country) => country.length >= 3)).toBe(true)
	})
})
