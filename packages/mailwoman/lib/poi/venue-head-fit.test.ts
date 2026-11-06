/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { rowFitsVenueHead } from "#poi/venue-head-fit"

describe("rowFitsVenueHead", () => {
	it("refuses a row whose category disagrees with the name's last word", () => {
		expect(rowFitsVenueHead("JFK Airport", "key_and_locksmith")).toBe(false)
		expect(rowFitsVenueHead("Detroit Metro Airport", "travel_service")).toBe(false)
		expect(rowFitsVenueHead("Central Park", "cafe")).toBe(false)
	})

	it("accepts a row filed under the stated category or a narrower one", () => {
		expect(rowFitsVenueHead("JFK Airport", "airport")).toBe(true)
		expect(rowFitsVenueHead("Central Park", "park")).toBe(true)
	})

	it("refuses a row with no category when the name states one", () => {
		expect(rowFitsVenueHead("Griffith Park", null)).toBe(false)
	})

	it("accepts any row when the last word states no category", () => {
		expect(rowFitsVenueHead("Empire State Building", "historic_site")).toBe(true)
		expect(rowFitsVenueHead("Empire State Building", null)).toBe(true)
	})
})
