/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { PlanetaryBuildManifestSchema, SourcesLockSchema } from "@mailwoman/astrogeology/schema/manifest"
import { PlanetaryNomenclatureFeatureSchema } from "@mailwoman/astrogeology/schema/nomenclature"
import { describe, expect, test } from "vitest"

const SHA = "a".repeat(64)

describe("SourcesLockSchema", () => {
	test("accepts a snapshot-pinned archive and a product-pinned DEM", () => {
		const lock = SourcesLockSchema.parse({
			"moon-nomenclature": {
				url: "https://example.test/MOON_nomenclature_center_pts.zip",
				bytes: 23_842_450,
				sha256: SHA,
				fetchedAt: "2026-09-07T20:00:00Z",
				snapshot: "2026-09-07",
			},
			"moon-dem": {
				url: "https://example.test/LDEM_118m.tif",
				bytes: 8_494_203_833,
				sha256: SHA,
				fetchedAt: "2026-09-07T20:00:00Z",
			},
		})

		expect(lock["moon-nomenclature"]?.snapshot).toBe("2026-09-07")
		expect(lock["moon-dem"]?.snapshot).toBeUndefined()
	})

	test.each([
		["a short hash", { sha256: "abc" }],
		["zero bytes", { bytes: 0 }],
		["a snapshot that is not a date", { snapshot: "yesterday" }],
	])("refuses %s", (_label, patch) => {
		const entry = { url: "https://example.test/a.zip", bytes: 1, sha256: SHA, fetchedAt: "2026-09-07T20:00:00Z" }

		expect(SourcesLockSchema.safeParse({ a: { ...entry, ...patch } }).success).toBe(false)
	})
})

describe("PlanetaryBuildManifestSchema", () => {
	test("accepts a manifest and refuses an unknown schema version", () => {
		const manifest = {
			schemaVersion: 1,
			body: "moon",
			builtAt: "2026-09-07T20:00:00Z",
			sources: [
				{
					id: "moon-nomenclature",
					url: "https://example.test/MOON_nomenclature_center_pts.zip",
					sha256: SHA,
					bytes: 23_842_450,
					snapshot: "2026-09-07",
					coordinates: {
						longitudeDirection: "east",
						longitudeRange: "0..360",
						latitudeType: "planetocentric",
						referenceBody: "Moon_2000_IAU_IAG (sphere, 1737400 m)",
					},
				},
			],
			outputs: [{ tileset: "moon", path: "moon.pmtiles", sha256: SHA, bytes: 1024 }],
			transformations: ["tippecanoe -o moon.pmtiles …"],
		}

		expect(PlanetaryBuildManifestSchema.parse(manifest).outputs).toHaveLength(1)
		expect(PlanetaryBuildManifestSchema.safeParse({ ...manifest, schemaVersion: 2 }).success).toBe(false)
	})
})

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
