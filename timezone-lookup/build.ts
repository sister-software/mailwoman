/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the timezone polygon DB from a timezone-boundary-builder GeoJSON
 *   (`combined-with-oceans.json`, features of `{ properties: { tzid }, geometry:
 *   Polygon|MultiPolygon }`). One row per feature: the tzid, a bounding box (for the lookup's
 *   prefilter), and the geometry normalized to MultiPolygon coordinates as JSON.
 */

import { readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import type { MultiPolygonCoords } from "./index.ts"

interface TimezoneFeature {
	properties: { tzid: string }
	geometry: { type: "Polygon" | "MultiPolygon"; coordinates: number[][][] | number[][][][] }
}

/** Read the GeoJSON at `geojsonPath` and write the polygon DB to `dbPath` (overwriting its table). */
export function buildTimezoneDB(geojsonPath: string, dbPath: string): { features: number } {
	const data = JSON.parse(readFileSync(geojsonPath, "utf8")) as { features: TimezoneFeature[] }
	const db = new DatabaseSync(dbPath)
	db.exec("DROP TABLE IF EXISTS timezone_polygons")
	db.exec(
		`CREATE TABLE timezone_polygons (tzid TEXT NOT NULL, minLat REAL, maxLat REAL, minLon REAL, maxLon REAL, geom TEXT NOT NULL)`
	)
	const insert = db.prepare(
		"INSERT INTO timezone_polygons (tzid, minLat, maxLat, minLon, maxLon, geom) VALUES (?,?,?,?,?,?)"
	)

	db.exec("BEGIN")

	for (const feature of data.features) {
		const polygons: MultiPolygonCoords =
			feature.geometry.type === "Polygon"
				? [feature.geometry.coordinates as number[][][]]
				: (feature.geometry.coordinates as number[][][][])

		let minLat = 90
		let maxLat = -90
		let minLon = 180
		let maxLon = -180

		for (const polygon of polygons) {
			for (const ring of polygon) {
				for (const point of ring) {
					const lon = point[0]!
					const lat = point[1]!

					if (lat < minLat) {
						minLat = lat
					}

					if (lat > maxLat) {
						maxLat = lat
					}

					if (lon < minLon) {
						minLon = lon
					}

					if (lon > maxLon) {
						maxLon = lon
					}
				}
			}
		}
		insert.run(feature.properties.tzid, minLat, maxLat, minLon, maxLon, JSON.stringify(polygons))
	}
	db.exec("COMMIT")
	db.exec("CREATE INDEX idx_tz_bbox ON timezone_polygons (minLat, maxLat, minLon, maxLon)")
	db.close()

	return { features: data.features.length }
}
