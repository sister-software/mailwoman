/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { coordinatePairText, parsePointQuery } from "#point-query"

test("coordinatePairText writes the pair the parser reads back", () => {
	expect(coordinatePairText(48.8584, 2.2945)).toBe("48.858400, 2.294500")

	expect(parsePointQuery(coordinatePairText(-33.865, 151.21))).toEqual({
		kind: "coordinates",
		lat: -33.865,
		lon: 151.21,
		order: "lat_lon",
	})
})

describe("parsePointQuery", () => {
	test("reads decimal pairs latitude first, in every common spelling", () => {
		const paris = { kind: "coordinates", lat: 48.8584, lon: 2.2945, order: "lat_lon" }

		expect(parsePointQuery("48.8584, 2.2945")).toEqual(paris)
		expect(parsePointQuery("48.8584,2.2945")).toEqual(paris)
		expect(parsePointQuery("48.8584 2.2945")).toEqual(paris)
		expect(parsePointQuery("  48.8584 ; 2.2945 ")).toEqual(paris)
		expect(parsePointQuery("geo:48.8584,2.2945")).toEqual(paris)
		expect(parsePointQuery("geo:48.8584,2.2945,35;u=10")).toEqual(paris)
		expect(parsePointQuery("@48.8584,2.2945,17z")).toEqual(paris)
		expect(parsePointQuery("lat 48.8584 lon 2.2945")).toEqual(paris)
		expect(parsePointQuery("latitude: 48.8584, longitude: 2.2945")).toEqual(paris)
	})

	test("reads hemisphere letters and degrees-minutes-seconds", () => {
		expect(parsePointQuery("48.8584N 2.2945E")).toEqual({
			kind: "coordinates",
			lat: 48.8584,
			lon: 2.2945,
			order: "lat_lon",
		})

		expect(parsePointQuery("2.2945E, 48.8584N")).toEqual({
			kind: "coordinates",
			lat: 48.8584,
			lon: 2.2945,
			order: "lon_lat",
		})

		const dms = parsePointQuery("38°53'51.72\"N 77°2'11.40\"W")

		expect(dms?.kind).toBe("coordinates")

		if (dms?.kind === "coordinates") {
			expect(dms.lat).toBeCloseTo(38.8977, 4)
			expect(dms.lon).toBeCloseTo(-77.0365, 4)
		}

		const unicode = parsePointQuery("33° 51′ 54″ S, 151° 12′ 36″ E")

		if (unicode?.kind === "coordinates") {
			expect(unicode.lat).toBeCloseTo(-33.865, 3)
			expect(unicode.lon).toBeCloseTo(151.21, 3)
		} else {
			throw new Error("the Sydney pair did not read as coordinates")
		}
	})

	test("falls back to longitude first only when latitude first is out of range", () => {
		expect(parsePointQuery("139.6917, 35.6895")).toEqual({
			kind: "coordinates",
			lat: 35.6895,
			lon: 139.6917,
			order: "lon_lat",
		})

		expect(parsePointQuery("200, 300")).toBeNull()
		expect(parsePointQuery("lng=2.2945, lng=48.8584")).toBeNull()
	})

	test("leaves addresses and bare numbers to the classifier", () => {
		expect(parsePointQuery("")).toBeNull()
		expect(parsePointQuery("90210")).toBeNull()
		expect(parsePointQuery("12 34")).toBeNull()
		expect(parsePointQuery("10 Downing Street, London")).toBeNull()
		expect(parsePointQuery("1600 Pennsylvania Ave NW, Washington, DC 20500")).toBeNull()
		expect(parsePointQuery("5 Hauptstraße, Berlin, Berlin 10115")).toBeNull()
		expect(parsePointQuery("Chicago, IL")).toBeNull()
		expect(parsePointQuery("Moscow, Russia")).toBeNull()
	})

	test("reads plus codes, full and short", () => {
		expect(parsePointQuery("764MVFQ6+92P")).toEqual({ kind: "plus_code", code: "764MVFQ6+92P", full: true })
		expect(parsePointQuery("vfq6+92p")).toEqual({ kind: "plus_code", code: "VFQ6+92P", full: false })
		expect(parsePointQuery("VFQ6+92P Managua")).toBeNull()
	})

	test("reads H3 cells, geohashes and Who's On First ids", () => {
		expect(parsePointQuery("8928308280FFFFF")).toEqual({ kind: "h3", cell: "8928308280fffff" })
		expect(parsePointQuery("h3:8928308280fffff")).toEqual({ kind: "h3", cell: "8928308280fffff" })
		expect(parsePointQuery("geohash:dqcjqcp")).toEqual({ kind: "geohash", hash: "dqcjqcp" })
		expect(parsePointQuery("gh:EZS42")).toEqual({ kind: "geohash", hash: "ezs42" })
		expect(parsePointQuery("ezs42")).toBeNull()

		expect(parsePointQuery("wof:1880762729")).toEqual({ kind: "wof", id: 1_880_762_729 })
		expect(parsePointQuery("WOF 85633793")).toEqual({ kind: "wof", id: 85_633_793 })
		expect(parsePointQuery("https://spelunker.whosonfirst.org/id/85633793/")).toEqual({ kind: "wof", id: 85_633_793 })
		expect(parsePointQuery("wof:0")).toBeNull()
	})
})
