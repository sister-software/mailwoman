/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"
import {
	coordinateFormatAnnotator,
	qiblaBearing,
	sunTimes,
	toDMS,
	toGeohash,
	toMaidenhead,
	toMercator,
	toMGRS,
} from "./coordinate-formats.js"

// The White House (38.8977, -77.0365) — reference values cross-checked against published converters.
const LAT = 38.8977
const LON = -77.0365

test("toDMS: signed decimals → D° M′ S″ with hemisphere", () => {
	const dms = toDMS(LAT, LON)
	expect(dms.lat).toBe("38° 53′ 51.72″ N")
	expect(dms.lon).toBe("77° 2′ 11.40″ W")
})

test("toMaidenhead: 6-char locator with lowercase subsquare", () => {
	expect(toMaidenhead(LAT, LON)).toBe("FM18lv")
})

test("toGeohash: precision-9, deterministic, DC prefix", () => {
	const gh = toGeohash(LAT, LON)
	expect(gh).toHaveLength(9)
	expect(gh.startsWith("dqc")).toBe(true)
	expect(toGeohash(LAT, LON)).toBe(gh)
})

test("toMercator: EPSG:3857 projection in range", () => {
	const { x, y } = toMercator(LAT, LON)
	expect(x).toBeGreaterThan(-8576000)
	expect(x).toBeLessThan(-8575000)
	expect(y).toBeGreaterThan(4690000)
	expect(y).toBeLessThan(4730000)
})

test("qiblaBearing: from DC the Kaaba is ~58° (ENE)", () => {
	const b = qiblaBearing(LAT, LON)
	expect(b).toBeGreaterThan(54)
	expect(b).toBeLessThan(62)
})

test("sunTimes: NYC summer solstice — sunrise ~09:26 UTC, ordered, ~15h day", () => {
	const s = sunTimes(40.7128, -74.006, new Date("2026-06-21T12:00:00Z"))
	const expectedRise = new Date("2026-06-21T09:26:00Z").getTime() / 1000
	expect(Math.abs(s.rise! - expectedRise)).toBeLessThan(600) // within 10 min
	expect(s.rise!).toBeLessThan(s.noon)
	expect(s.noon).toBeLessThan(s.set!)
	expect((s.set! - s.rise!) / 3600).toBeGreaterThan(14.5)
})

test("sunTimes: polar day has no sunrise/sunset, only solar noon", () => {
	const s = sunTimes(80, 0, new Date("2026-06-21T12:00:00Z"))
	expect(s.rise).toBeUndefined()
	expect(s.set).toBeUndefined()
	expect(typeof s.noon).toBe("number")
})

test("toMGRS: Washington Monument matches Wikipedia's vector (~4m); zone+band elsewhere; empty in polar bands", () => {
	// Wikipedia MGRS article cites 18S UJ 23487 06483 for the monument; we match to ~4m.
	expect(toMGRS(38.88949, -77.03524)).toBe("18SUJ2348306482")
	expect(toMGRS(-33.8688, 151.2093).startsWith("56H")).toBe(true) // Sydney, zone 56 band H
	expect(toMGRS(85, 0)).toBe("") // above 84°N — MGRS bands stop
})

test("coordinateFormatAnnotator: fills the coordinate-format slice of an AnnotationSet", () => {
	const set = coordinateFormatAnnotator({ lat: LAT, lon: LON })
	expect(set.maidenhead).toBe("FM18lv")
	expect(set.geohash).toHaveLength(9)
	expect(set.dms?.lat).toContain("N")
	expect(typeof set.qiblaBearing).toBe("number")
	expect(set.mercator?.x).toBeLessThan(0)
})
