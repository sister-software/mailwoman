/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"
import {
	coordinateFormatAnnotator,
	qiblaBearing,
	toDMS,
	toGeohash,
	toMaidenhead,
	toMercator,
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

test("coordinateFormatAnnotator: fills the coordinate-format slice of an AnnotationSet", () => {
	const set = coordinateFormatAnnotator({ lat: LAT, lon: LON })
	expect(set.maidenhead).toBe("FM18lv")
	expect(set.geohash).toHaveLength(9)
	expect(set.dms?.lat).toContain("N")
	expect(typeof set.qiblaBearing).toBe("number")
	expect(set.mercator?.x).toBeLessThan(0)
})
