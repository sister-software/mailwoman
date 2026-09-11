/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Samples interior points from the coastal artifact for verification.
 */

import { strideSampleInteriorPoints } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import type { CoastalDatabase } from "#schema"

/**
 * Draw a reproducible sample of points from the artifact — interior points of stored polygons, across scenarios.
 *
 * SPREAD ACROSS SCENARIOS RATHER THAN DRAWN FROM ONE, because the twelve scenarios are twelve claims and a sample from
 * one would verify one twelfth of the artifact while reporting on all of it. The stride discipline — keys chosen before
 * any geometry is read, deterministic rather than random — is `strideSampleInteriorPoints`'s.
 */
export function sampleAgreementPoints(
	databasePath: string,
	options: { count?: number } = {}
): Array<{ label: string; latitude: number; longitude: number; scenarioKey: string }> {
	const count = options.count ?? 48
	using database = new DatabaseClient<CoastalDatabase>(databasePath, { readOnly: true })

	const areaIDs = (
		database.prepare("SELECT area_id FROM coastal_zone_area ORDER BY area_id").all() as Array<{ area_id: string }>
	).map((row) => row.area_id)

	const selectArea = database.prepare(
		"SELECT area_id, scenario_key, min_lat, min_lon, max_lat, max_lon, rings FROM coastal_zone_area WHERE area_id = ?"
	)

	return strideSampleInteriorPoints(areaIDs, count, {
		fetch: (key) =>
			selectArea.get(key) as
				| {
						area_id: string
						scenario_key: string
						min_lat: number
						min_lon: number
						max_lat: number
						max_lon: number
						rings: Uint8Array
				  }
				| undefined,
		gridSteps: 17,
		toPoint: (area, interior) => ({
			label: `${area.scenario_key} polygon ${area.area_id}`,
			scenarioKey: area.scenario_key,
			...interior,
		}),
	})
}
