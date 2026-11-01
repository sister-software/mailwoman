/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests that the house-venue recipe gives each generated address its own source_id.
 */

import { describe, expect, it } from "vitest"

import { houseVenueRecipe } from "#recipes/house/venue"
import { recipeRunner } from "#test-kit/corpus-recipe"

const run = recipeRunner("house-venue", houseVenueRecipe, 4242)

// Two streets in one postcode: before #2894 every row of a postcode, template and variant shared one id.
const TUPLES = [
	{ street: "Bryden Avenue", locality: "Lewiston", region: "ID", postcode: "83501", country: "US" },
	{ street: "Prospect Avenue", locality: "Lewiston", region: "ID", postcode: "83501", country: "US" },
]

describe("house-venue: source ids", () => {
	it("gives rows with different text different ids", async () => {
		const { rows } = await run(TUPLES, [], { variants: 8 })
		const idsByRaw = new Map<string, Set<string>>()

		for (const { source_id: id, raw } of rows) {
			if (!id) throw new Error(`row ${raw} carries no source_id`)

			const raws = idsByRaw.get(id) ?? new Set<string>()

			raws.add(raw)
			idsByRaw.set(id, raws)
		}

		expect(rows.length).toBeGreaterThan(TUPLES.length)
		expect([...idsByRaw.values()].filter((raws) => raws.size > 1)).toEqual([])
	})
})
