/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Samples flood artifact points for verification.
 */

import { expandH3Cell, strideSampleInteriorPoints, type H3CellShort } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { cellToLatLng } from "h3-js"

import type { FloodDatabase } from "#schema"

/**
 * Draw a reproducible sample of points from the artifact: some inside polygons, some inside the footprint and outside
 * every polygon.
 *
 * BOTH KINDS ARE REQUIRED. A sample drawn only from inside polygons never exercises the designated-absence reading,
 * which is the reading this product's Zone-1-as-absence design turns on — and an artifact that answered `unknown`
 * everywhere except inside a polygon would pass a polygon-only sample. The stride discipline — keys chosen before any
 * geometry is read, deterministic rather than random — is `strideSampleInteriorPoints`'s.
 */
export function sampleAgreementPoints(
	databasePath: string,
	options: { insideCount?: number; absenceCount?: number } = {}
): Array<{ label: string; latitude: number; longitude: number }> {
	const insideCount = options.insideCount ?? 40
	const absenceCount = options.absenceCount ?? 20
	using database = new DatabaseClient<FloodDatabase>(databasePath, { readOnly: true })

	const areaIDs = (
		database.prepare("SELECT area_id FROM flood_zone_area ORDER BY area_id").all() as Array<{ area_id: string }>
	).map((row) => row.area_id)

	const selectArea = database.prepare(
		"SELECT area_id, zone_code, min_lat, min_lon, max_lat, max_lon, rings FROM flood_zone_area WHERE area_id = ?"
	)

	const points: Array<{ label: string; latitude: number; longitude: number }> = strideSampleInteriorPoints(
		areaIDs,
		insideCount,
		{
			fetch: (key) =>
				selectArea.get(key) as
					| {
							area_id: string
							zone_code: string
							min_lat: number
							min_lon: number
							max_lat: number
							max_lon: number
							rings: Uint8Array
					  }
					| undefined,
			gridSteps: 7,
			toPoint: (area, interior) => ({ label: `${area.zone_code} polygon ${area.area_id}`, ...interior }),
		}
	)

	// A designated absence is a coverage cell the authority determined and no polygon reaches — exactly the cells whose
	// `observed_rows` is zero, which is the storable form of a Zone 1 designation.
	const emptyCount = (
		database.prepare("SELECT count(*) AS n FROM layer_coverage WHERE observed_rows = 0").get() as { n: number }
	).n

	const emptyStride = Math.max(1, Math.floor(emptyCount / Math.max(1, absenceCount)))

	const emptyCells = database
		.prepare("SELECT h3_cell FROM layer_coverage WHERE observed_rows = 0 ORDER BY h3_cell")
		.all() as Array<{ h3_cell: number }>

	const coverageResolution = (
		database.prepare("SELECT coverage_resolution AS r FROM flood_map_extent").get() as { r: number }
	).r

	for (let index = 0; index < emptyCells.length && points.length < insideCount + absenceCount; index += emptyStride) {
		const short = emptyCells[index]!.h3_cell.toString(16).padStart(13, "0") as H3CellShort
		const cell = expandH3Cell(short, coverageResolution)
		const [latitude, longitude] = cellToLatLng(cell)

		points.push({ label: `designated absence in ${cell}`, latitude, longitude })
	}

	return points
}
