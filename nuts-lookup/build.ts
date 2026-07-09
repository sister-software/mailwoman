/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the NUTS polygon DB from a Eurostat GISCO NUTS GeoJSON (`NUTS_RG_*_4326.geojson`: features
 *   of `{ properties: { NUTS_ID, LEVL_CODE }, geometry: Polygon|MultiPolygon }`). One row per
 *   region, with its level and bounding box for the lookup's prefilter.
 */

import { readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import type { MultiPolygonCoords } from "./index.ts"

interface NutsFeature {
	properties: { NUTS_ID: string; LEVL_CODE: number }
	geometry: { type: "Polygon" | "MultiPolygon"; coordinates: number[][][] | number[][][][] }
}

/** Read the NUTS GeoJSON at `geojsonPath` and write the polygon DB to `dbPath`. */
export function buildNutsDB(geojsonPath: string, dbPath: string): { regions: number } {
	const data = JSON.parse(readFileSync(geojsonPath, "utf8")) as { features: NutsFeature[] }
	const db = new DatabaseSync(dbPath)
	db.exec("DROP TABLE IF EXISTS nuts_regions")
	// `nutsId` is a string contract with every shipped nuts.db — the acronym-casing convention applies
	// to TS identifiers, not DB columns (readers alias it: `SELECT nutsId AS nutsID`).
	db.exec(
		"CREATE TABLE nuts_regions (nutsId TEXT NOT NULL, level INTEGER, minLat REAL, maxLat REAL, minLon REAL, maxLon REAL, geom TEXT NOT NULL)"
	)
	const insert = db.prepare(
		"INSERT INTO nuts_regions (nutsId, level, minLat, maxLat, minLon, maxLon, geom) VALUES (?,?,?,?,?,?,?)"
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
		insert.run(
			feature.properties.NUTS_ID,
			feature.properties.LEVL_CODE,
			minLat,
			maxLat,
			minLon,
			maxLon,
			JSON.stringify(polygons)
		)
	}
	db.exec("COMMIT")
	db.exec("CREATE INDEX idx_nuts_level_bbox ON nuts_regions (level, minLat, maxLat, minLon, maxLon)")
	db.close()

	return { regions: data.features.length }
}
