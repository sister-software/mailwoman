/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { renderOSMExtractRecord } from "#tools/eval-harness/osm-suites/extract"
import { OSMSuiteShape, suiteShapesOf } from "#tools/eval-harness/osm-suites/shapes"

const shapesOf = (country: string, record: Record<string, string>) => {
	const row = renderOSMExtractRecord(record, country, {})

	return row ? suiteShapesOf(row) : null
}

describe("suiteShapesOf on rows rendered as the osm adapter renders them", () => {
	it("reads a unit", () => {
		expect(shapesOf("NO", { street: "Storgata", number: "1", unit: "H0101", postcode: "0155", city: "Oslo" })).toEqual([
			OSMSuiteShape.Unit,
		])
	})

	it("reads a suburb written before its city", () => {
		expect(
			shapesOf("DE", {
				street: "Große Bergstraße",
				number: "152",
				postcode: "22767",
				suburb: "Altona",
				city: "Hamburg",
			})
		).toEqual([OSMSuiteShape.SuburbBeforeCity])
	})

	it("reads a region written after the locality, beside a unit", () => {
		expect(
			shapesOf("US", {
				street: "Main Street",
				number: "302",
				unit: "STE 302",
				city: "Springfield",
				province: "IL",
				postcode: "62701",
			})
		).toEqual([OSMSuiteShape.Unit, OSMSuiteShape.RegionAfterLocality])
	})

	it("reads a house number within a named place", () => {
		expect(shapesOf("PK", { number: "12", place: "DHA Phase 6", city: "Karachi" })).toEqual([
			OSMSuiteShape.SuburbBeforeCity,
			OSMSuiteShape.PlaceWithoutStreet,
		])
	})

	it("reads no shape from a plain street address", () => {
		expect(shapesOf("AL", { street: "Bulevardi Zogu I", number: "1", city: "Tirane" })).toEqual([])
	})
})
