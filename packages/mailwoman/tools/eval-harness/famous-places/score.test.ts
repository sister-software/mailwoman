/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { JSONSpliterator } from "spliterator"
import { describe, expect, it } from "vitest"

import { FAMOUS_PLACES_FIXTURE, type FamousPlaceRow, matchesExpectedComponents } from "./score.ts"

describe("matchesExpectedComponents", () => {
	it("accepts the expected components with any case", () => {
		expect(matchesExpectedComponents({ venue: "Eiffel Tower" }, { venue: "eiffel tower" })).toBe(true)
	})

	it("refuses a parse that splits the name or adds a component", () => {
		expect(
			matchesExpectedComponents({ venue: "Christ the Redeemer" }, { locality: "Christ The", region: "Redeemer" })
		).toBe(false)

		expect(matchesExpectedComponents({ locality: "Berlin" }, { locality: "Berlin", region: "Berlin" })).toBe(false)
	})

	it("refuses a parse that labels the place with another tag", () => {
		expect(
			matchesExpectedComponents(
				{ locality: "Zurich", country: "Switzerland" },
				{ region: "Zurich", country: "Switzerland" }
			)
		).toBe(false)
	})
})

describe("the famous-places fixture", async () => {
	const rows = await JSONSpliterator.fromAsync<FamousPlaceRow>(
		new URL("./famous-places.v0.jsonl", import.meta.url).pathname
	).toArray()

	it("expects every name to be one span the input contains", () => {
		for (const row of rows) {
			for (const value of Object.values(row.components)) {
				expect(row.input).toContain(value)
			}
		}
	})

	it("expects locality for a capital and venue for every other place", () => {
		for (const row of rows) {
			const tag = row.kind === "capital" ? "locality" : "venue"
			const expected = Object.keys(row.components).filter((key) => key !== "country")

			expect(expected).toEqual([tag])
		}
	})

	it("states a coordinate and a tolerance for every row", () => {
		for (const row of rows) {
			expect(Math.abs(row.lat)).toBeLessThanOrEqual(90)
			expect(Math.abs(row.lon)).toBeLessThanOrEqual(180)
			expect(row.tolerance_m).toBeGreaterThan(0)
		}
	})

	it("is the file the scorer reads by default", () => {
		expect(FAMOUS_PLACES_FIXTURE.endsWith("famous-places/famous-places.v0.jsonl")).toBe(true)
	})
})
