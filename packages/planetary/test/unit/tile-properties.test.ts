/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { featureFromTileProperties } from "@mailwoman/planetary/features/tile-properties"
import { expect, test } from "vitest"

const TYCHO = {
	id: "6163",
	body: "moon",
	name: "Tycho",
	cleanName: "Tycho",
	featureType: "Crater, craters",
	featureTypeCode: "AA",
	diameterKm: 85.29377,
	approvalStatus: "Adopted by IAU",
	approvalDate: "1935-01-01",
	origin: "Tycho Brahe; Danish astronomer (1546-1601).",
	source: "usgs-iau",
}

const CENTER = { longitude: -11.2153, latitude: -43.3054 }

test("a nomenclature tile feature becomes a selection with the geometry's center", () => {
	expect(featureFromTileProperties(TYCHO, CENTER)).toEqual({
		id: "6163",
		name: "Tycho",
		featureType: "Crater, craters",
		featureTypeCode: "AA",
		diameterKm: 85.29377,
		approvalStatus: "Adopted by IAU",
		approvalDate: "1935-01-01",
		origin: "Tycho Brahe; Danish astronomer (1546-1601).",
		centerLon: CENTER.longitude,
		centerLat: CENTER.latitude,
	})
})

test("the optional fields are absent, not empty strings, when the tile carries none", () => {
	const selection = featureFromTileProperties({ id: "1", name: "Marvin", featureType: "Crater, craters" }, CENTER)

	expect(selection).toEqual({
		id: "1",
		name: "Marvin",
		featureType: "Crater, craters",
		centerLon: CENTER.longitude,
		centerLat: CENTER.latitude,
	})

	expect(selection && "origin" in selection).toBe(false)
})

test("a feature without a name or an id is not a selection", () => {
	expect(featureFromTileProperties({ name: "Tycho" }, CENTER)).toBeNull()
	expect(featureFromTileProperties({ id: "6163", featureType: "Crater, craters" }, CENTER)).toBeNull()
	expect(featureFromTileProperties(null, CENTER)).toBeNull()
})
