// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { parseJSONStrict } from "@mailwoman/core/json"
import {
	crossingsStatement,
	streetsInPlacesStatement,
	streetsNearStatement,
	type CrossingHit,
	type CrossingTableQuery,
	type StreetTableArea,
	type StreetTableHit,
	type StreetTableLookup,
	type StreetTableQuery,
} from "@mailwoman/resolver-wof-sqlite/street/table"
import { haversine } from "@mailwoman/spatial/geometries/point/distance"

import type { RangeDatabase } from "#httpvfs/database"

interface StreetInPlaceRow {
	id: number
	name: string
	latitude: number
	longitude: number
	meters: number
}

interface StreetNearRow {
	id: number
	name: string
	points: string
	meters: number
}

/**
 * Reads a street's stored link midpoints and returns the one nearest the area's center,
 * when it lies inside the area.
 */
function nearestPoint({ id, name, points, meters }: StreetNearRow, area: StreetTableArea): StreetTableHit | null {
	const flat = parseJSONStrict<number[]>(points)
	let best: StreetTableHit | null = null

	for (let index = 0; index + 1 < flat.length; index += 2) {
		const lat = flat[index]!
		const lon = flat[index + 1]!
		const distanceM = haversine(area.lat, area.lon, lat, lon, "meters")

		if (distanceM <= area.radiusM && (!best || distanceM < best.distanceM!)) {
			best = { streetID: id, name, lat, lon, meters, distanceM }
		}
	}

	return best
}

/**
 * Reads a sealed street table over range requests, as a Worker reads it from R2.
 */
export class RangeStreetTable implements StreetTableLookup {
	readonly #database: RangeDatabase

	constructor(database: RangeDatabase) {
		this.#database = database
	}

	async findStreets({ street, places, near }: StreetTableQuery): Promise<StreetTableHit[]> {
		if (places?.length) {
			const rows = await this.#database.query<StreetInPlaceRow>(...streetsInPlacesStatement(street, places))

			return rows.map(({ id, name, latitude, longitude, meters }) => ({
				streetID: id,
				name,
				lat: latitude,
				lon: longitude,
				meters,
				distanceM: null,
			}))
		}

		if (!near) return []

		const rows = await this.#database.query<StreetNearRow>(...streetsNearStatement(street, near))

		return rows
			.map((row) => nearestPoint(row, near))
			.filter((hit): hit is StreetTableHit => hit !== null)
			.toSorted((a, b) => a.distanceM! - b.distanceM!)
	}

	async findCrossings(query: CrossingTableQuery): Promise<CrossingHit[]> {
		const rows = await this.#database.query<{ latitude: number; longitude: number; nodes: number }>(
			...crossingsStatement(query)
		)

		return rows.map(({ latitude, longitude, nodes }) => ({ lat: latitude, lon: longitude, nodes }))
	}
}
