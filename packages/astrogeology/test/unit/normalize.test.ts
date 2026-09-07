/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	approvalDateFromSource,
	featureFromSourceRow,
	featureIDFromLink,
	normalizeBBox,
	normalizeLongitude,
} from "@mailwoman/astrogeology/normalize"
import { describe, expect, test } from "vitest"

describe("normalizeLongitude", () => {
	test.each([
		[0, 0],
		[180, 180],
		[180.0001, -179.9999],
		[359.6815, -0.3185],
		[360, 0],
		[226.1975, -133.8025],
	])("%s → %s", (input, expected) => {
		expect(normalizeLongitude(input)).toBeCloseTo(expected, 6)
	})

	test("refuses a longitude outside 0..360 and -180..180", () => {
		expect(() => normalizeLongitude(361)).toThrow(/longitude/u)
		expect(() => normalizeLongitude(-181)).toThrow(/longitude/u)
	})
})

describe("normalizeBBox", () => {
	test("a box straddling 360 stays narrow (Marco Polo P)", () => {
		const box = normalizeBBox({ minLon: 359.1977, maxLon: 360.1643, minLat: 16.5046, maxLat: 17.4301 })
		expect(box.minLon).toBeCloseTo(-0.8023, 4)
		expect(box.maxLon).toBeCloseTo(0.1643, 4)
		expect(box.maxLon - box.minLon).toBeLessThan(1)
	})

	test("a box straddling 180 keeps its width and marks the antimeridian", () => {
		const box = normalizeBBox({ minLon: 178, maxLon: 182, minLat: -1, maxLat: 1 })
		expect(box.crossesAntimeridian).toBe(true)
		expect(box.minLon).toBeCloseTo(178, 6)
		expect(box.maxLon).toBeCloseTo(-178, 6)
	})

	test("a polar box clamps latitude to ±90", () => {
		expect(normalizeBBox({ minLon: 10, maxLon: 20, minLat: 88, maxLat: 90.4 }).maxLat).toBe(90)
	})
})

test("featureIDFromLink reads the trailing id", () => {
	expect(featureIDFromLink("http://planetarynames.wr.usgs.gov/Feature/11150")).toBe("11150")
	expect(() => featureIDFromLink("http://planetarynames.wr.usgs.gov/")).toThrow(/link/u)
})

test("approvalDateFromSource keeps the date and drops the zero time", () => {
	expect(approvalDateFromSource("2006/01/01 00:00:00")).toBe("2006-01-01")
	expect(approvalDateFromSource("")).toBeUndefined()
})

test("featureFromSourceRow projects Tycho", () => {
	const feature = featureFromSourceRow("moon", {
		name: "Tycho",
		clean_name: "Tycho",
		approvaldt: "1935/01/01 00:00:00",
		origin: "",
		diameter: 85.29377,
		center_lon: 348.7847,
		center_lat: -43.2958,
		type: "Crater, craters",
		code: "AA",
		approval: "Adopted by IAU",
		min_lon: 346.8521,
		max_lon: 350.7172,
		min_lat: -45.2,
		max_lat: -41.4,
		quad_name: "Tycho",
		link: "http://planetarynames.wr.usgs.gov/Feature/6163",
	})

	expect(feature).toMatchObject({
		id: "6163",
		body: "moon",
		name: "Tycho",
		featureType: "Crater, craters",
		featureTypeCode: "AA",
		diameterKm: 85.29377,
		approvalStatus: "Adopted by IAU",
		approvalDate: "1935-01-01",
		source: "usgs-iau",
	})

	expect(feature.centerLon).toBeCloseTo(-11.2153, 4)
	expect(feature.centerLat).toBeCloseTo(-43.2958, 4)
	expect(feature.origin).toBeUndefined()
})

test("featureFromSourceRow takes null for an absent attribute, as the Mars archive writes it", () => {
	const feature = featureFromSourceRow("mars", {
		name: "Diacria",
		clean_name: "Diacria",
		approvaldt: "1958/01/01 00:00:00",
		origin: null,
		diameter: 0,
		center_lon: 180,
		center_lat: 49.6666,
		type: "Albedo Feature",
		code: "AL",
		approval: "Adopted by IAU",
		min_lon: 180,
		max_lon: 180,
		min_lat: 49.6666,
		max_lat: 49.6666,
		quad_name: null,
		link: "http://planetarynames.wr.usgs.gov/Feature/1522",
	})

	expect(feature.origin).toBeUndefined()
	expect(feature.quadName).toBeUndefined()
	expect(feature.diameterKm).toBe(0)
	expect(feature.centerLon).toBe(180)
})
