/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A Nominatim result states the register row behind its coordinate under its `mailwoman` block, and its
 *   `licence` carries the OpenStreetMap credit exactly when that row came from an OpenStreetMap layer.
 */

import { OPENSTREETMAP_CREDIT } from "@mailwoman/core/geocode"
import { describe, expect, it } from "vitest"

import {
	MAILWOMAN_LICENCE,
	nominatimCreditFor,
	type ResolvedAddress,
	toFeatureCollection,
	toNominatimResult,
} from "#format"

const THAMES: ResolvedAddress = {
	lat: -37.137364,
	lon: 175.541779,
	address: { house_number: "620B", road: "Pollen Street", city: "Thames", country_code: "nz" },
}

describe("toNominatimResult", () => {
	it("keeps an OpenStreetMap row's stamp and credits OpenStreetMap in `licence`", () => {
		const result = toNominatimResult({
			...THAMES,
			coordinateSource: { source: "openstreetmap:nz", release: "2026-08-06" },
		})

		expect(result.mailwoman?.coordinate_source).toEqual({ source: "openstreetmap:nz", release: "2026-08-06" })
		expect(result.licence).toBe(`${MAILWOMAN_LICENCE}; ${OPENSTREETMAP_CREDIT}`)
	})

	it("keeps both in the geojson feature's properties", () => {
		const result = toNominatimResult({
			...THAMES,
			coordinateSource: { source: "openstreetmap:nz#recovered", release: "2026-08-06" },
		})

		const [feature] = toFeatureCollection([result]).features

		expect(feature?.properties["mailwoman"]).toEqual({
			coordinate_source: { source: "openstreetmap:nz#recovered", release: "2026-08-06" },
		})

		expect(feature?.properties["licence"]).toContain(OPENSTREETMAP_CREDIT)
	})

	it("reports a non-OSM row under its own stamp and never gains the OpenStreetMap credit", () => {
		const result = toNominatimResult({
			...THAMES,
			coordinateSource: { source: "overture:NAD", release: "2026-05-20.0" },
		})

		expect(result.mailwoman?.coordinate_source.source).toBe("overture:NAD")
		expect(result.licence).toBe(MAILWOMAN_LICENCE)
		expect(result.licence).not.toContain("OpenStreetMap")
	})

	it("carries no block and no OpenStreetMap credit when no register row placed the coordinate", () => {
		const result = toNominatimResult(THAMES)

		expect(result.mailwoman).toBeUndefined()
		expect(result.licence).toBe(MAILWOMAN_LICENCE)
	})
})

describe("nominatimCreditFor", () => {
	it("credits OpenStreetMap for the openstreetmap: prefix alone", () => {
		expect(nominatimCreditFor({ source: "openstreetmap:gb", release: null })).toContain(OPENSTREETMAP_CREDIT)
		expect(nominatimCreditFor({ source: "osm-derived:gb", release: null })).toBe(MAILWOMAN_LICENCE)
		expect(nominatimCreditFor(null)).toBe(MAILWOMAN_LICENCE)
	})
})
