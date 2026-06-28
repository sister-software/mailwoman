/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { MAILWOMAN_LICENCE, type ResolvedAddress, toFeatureCollection, toNominatimResult } from "./index.js"

const dc: ResolvedAddress = {
	lat: 38.8977,
	lon: -77.0365,
	address: {
		house_number: "1600",
		road: "Pennsylvania Ave NW",
		city: "Washington",
		state: "DC",
		postcode: "20500",
		country: "United States",
		country_code: "us",
	},
}

test("toFeatureCollection: wraps results as a GeoJSON FeatureCollection (geometry + bbox + properties)", () => {
	const r = toNominatimResult({ ...dc, boundingbox: ["38.89", "38.90", "-77.04", "-77.03"] })
	const fc = toFeatureCollection([r, { ...r, lat: null as never, lon: null as never }])

	expect(fc.type).toBe("FeatureCollection")
	// the row without a coordinate is dropped — a Feature needs a geometry.
	expect(fc.features).toHaveLength(1)
	const f = fc.features[0]!
	expect(f.type).toBe("Feature")
	expect(f.geometry).toEqual({ type: "Point", coordinates: [-77.0365, 38.8977] })
	// boundingbox [south, north, west, east] → GeoJSON bbox [west, south, east, north]
	expect(f.bbox).toEqual([-77.04, 38.89, -77.03, 38.9])
	// the coordinate + boundingbox move OUT of properties; the rest stays.
	expect(f.properties["display_name"]).toBeDefined()
	expect(f.properties["lat"]).toBeUndefined()
	expect(f.properties["boundingbox"]).toBeUndefined()
})

test("toNominatimResult: renders lat/lon as strings + a joined display_name + licence", () => {
	const r = toNominatimResult(dc)
	expect(r.lat).toBe("38.8977")
	expect(r.lon).toBe("-77.0365")
	expect(r.licence).toBe(MAILWOMAN_LICENCE)
	expect(r.display_name).toBe("1600, Pennsylvania Ave NW, Washington, DC, 20500, United States, us")
	expect(typeof r.place_id).toBe("number")
})

test("toNominatimResult: addressdetails gates the address block", () => {
	expect(toNominatimResult(dc).address).toBeUndefined()
	expect(toNominatimResult(dc, { addressdetails: true }).address).toEqual(dc.address)
})

test("toNominatimResult: an explicit displayName overrides the join", () => {
	expect(toNominatimResult({ ...dc, displayName: "The White House" }).display_name).toBe("The White House")
})

test("toNominatimResult: place_id is stable for the same input, distinct across inputs", () => {
	expect(toNominatimResult(dc).place_id).toBe(toNominatimResult(dc).place_id)
	expect(toNominatimResult(dc).place_id).not.toBe(toNominatimResult({ ...dc, lat: 0, lon: 0 }).place_id)
})

test("toNominatimResult: carries class/type/importance/boundingbox when present", () => {
	const r = toNominatimResult({
		...dc,
		category: "building",
		type: "government",
		importance: 0.8,
		boundingbox: ["38.89", "38.90", "-77.04", "-77.03"],
	})
	expect(r.class).toBe("building")
	expect(r.type).toBe("government")
	expect(r.importance).toBe(0.8)
	expect(r.boundingbox).toEqual(["38.89", "38.90", "-77.04", "-77.03"])
})
