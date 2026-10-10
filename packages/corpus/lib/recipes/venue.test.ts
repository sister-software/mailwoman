/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { recipeSource } from "#recipes/sources"
import { isBareVenueName, tupleCountryCode, venueNameKey, venueRecipe } from "#recipes/venue"

describe("isBareVenueName", () => {
	it("admits a name of two or more words with a word of letters", () => {
		expect(isBareVenueName("Manchester Art Gallery")).toBe(true)
		expect(isBareVenueName("Musée d'Orsay")).toBe(true)
	})

	it("refuses a one-word name and a name of codes", () => {
		expect(isBareVenueName("Blackwell")).toBe(false)
		expect(isBareVenueName("24 7")).toBe(false)
		expect(isBareVenueName("A1 B2")).toBe(false)
	})
})

describe("venueNameKey", () => {
	it("folds case and whitespace, keeping diacritics", () => {
		expect(venueNameKey("  Saint-Étienne ")).toBe("saint-étienne")
		expect(venueNameKey("New  York")).toBe("new york")
	})
})

describe("tupleCountryCode", () => {
	it("reads the code from `cc` and then from a two-letter `country`", () => {
		expect(tupleCountryCode({ country: "France", cc: "FR" })).toBe("FR")
		expect(tupleCountryCode({ country: "gb" })).toBe("GB")
		expect(tupleCountryCode({ country: "France" })).toBeNull()
	})
})

describe("venueRecipe", () => {
	it("requires the admin tuples", async () => {
		await expect(venueRecipe.run({ output: "", seed: 1, variants: 1 }, () => {})).rejects.toThrow(/--input/u)
	})

	it("writes two sources the table records", () => {
		expect(recipeSource("fragment-venue-bare")?.producer).toBe("recipes/venue.ts")
		expect(recipeSource("spliced-venue-locality")?.producer).toBe("recipes/venue.ts")
	})
})
