/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { PlanetaryNomenclatureFeatureSchema } from "@mailwoman/astrogeology/schema/nomenclature"
import { describe, expect, test } from "vitest"

const TYCHO = {
	id: "6163",
	body: "moon",
	name: "Tycho",
	cleanName: "Tycho",
	featureType: "Crater, craters",
	featureTypeCode: "AA",
	diameterKm: 85.29377,
	centerLon: -11.2153,
	centerLat: -43.2958,
	bbox: { minLon: -13.1479, maxLon: -9.2828, minLat: -45.2, maxLat: -41.4, crossesAntimeridian: false },
	approvalStatus: "Adopted by IAU",
	approvalDate: "1935-01-01",
	origin: "",
	quadName: "Tycho",
	source: "usgs-iau",
}

const OLYMPUS_MONS = {
	id: "4463",
	body: "mars",
	name: "Olympus Mons",
	cleanName: "Olympus Mons",
	featureType: "Mons, montes",
	featureTypeCode: "MO",
	diameterKm: 610.13,
	centerLon: -133.8025,
	centerLat: 18.6528,
	approvalStatus: "Adopted by IAU",
	approvalDate: "1973-01-01",
	origin: "Classical albedo feature name.",
	quadName: "Tharsis",
	source: "usgs-iau",
}

describe("PlanetaryNomenclatureFeatureSchema", () => {
	test("accepts Tycho and maps a blank origin to absence", () => {
		const feature = PlanetaryNomenclatureFeatureSchema.parse(TYCHO)
		expect(feature.origin).toBeUndefined()
		expect(feature.cleanName).toBe("Tycho")
	})

	test("accepts Olympus Mons without a bounding box", () => {
		expect(PlanetaryNomenclatureFeatureSchema.parse(OLYMPUS_MONS).bbox).toBeUndefined()
	})

	test.each([
		["another body", { ...TYCHO, body: "venus" }],
		["a latitude of 91", { ...TYCHO, centerLat: 91 }],
		["a longitude of 181", { ...TYCHO, centerLon: 181 }],
		["a missing id", { ...TYCHO, id: undefined }],
	])("refuses %s", (_label, value) => {
		expect(PlanetaryNomenclatureFeatureSchema.safeParse(value).success).toBe(false)
	})
})
