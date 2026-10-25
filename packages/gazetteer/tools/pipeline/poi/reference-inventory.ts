/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Read one POI class from a sealed POI layer. Capture-recapture estimation uses it as the second inventory.
 *   The handle opens with `readOnly`, so this function cannot reopen or patch the shipped `poi.db`.
 *
 *   The category uses a label rather than a number. `poi.category_id` is a per-build dictionary code.
 *   `pharmacy` maps to 72 in the 2026-07-22 build. A later build can assign another code.
 *   The lookup uses `poi_category_codes` and refuses a class the artifact does not hold.
 *   A numeric literal could read another class's rows under this class's name.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import type { POIDatabase } from "@mailwoman/resolver-wof-sqlite/poi"
import type { LatLonBounds } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

export interface ReferenceInventoryQuery {
	/**
	 * Path to a sealed POI layer database.
	 */
	databasePath: PathBuilderLike
	/**
	 * A `poi_category_codes.category` value, e.g. `pharmacy`.
	 */
	category: string
	/**
	 * Coarse pre-clip.
	 *
	 * Must contain the region of interest — the caller clips exactly, on the H3 cell set.
	 */
	bbox: LatLonBounds
}

export interface ReferenceRow {
	name: string | null
	latitude: number
	longitude: number
}

export interface ReferenceInventory {
	category: string
	categoryID: number
	rows: ReferenceRow[]
}

/**
 * Every row of `category` inside `bbox`.
 *
 * @throws When the artifact holds no such category.
 */
export async function readReferenceInventory(query: ReferenceInventoryQuery): Promise<ReferenceInventory> {
	using db = new DatabaseClient<POIDatabase>(query.databasePath, { readOnly: true })

	const code = await db
		.selectFrom("poi_category_codes")
		.select(["id"])
		.where("category", "=", query.category)
		.executeTakeFirst()

	if (!code) {
		throw new Error(
			`readReferenceInventory: ${query.databasePath} holds no category ${stringifyJSON(query.category)} — ` +
				`the reference layer cannot answer for a class it never ingested`
		)
	}

	const categoryID = Number(code.id)

	const rows = await db
		.selectFrom("poi")
		.select(["name", "latitude", "longitude"])
		.where("category_id", "=", categoryID)
		.where("latitude", ">=", query.bbox.minLat)
		.where("latitude", "<=", query.bbox.maxLat)
		.where("longitude", ">=", query.bbox.minLon)
		.where("longitude", "<=", query.bbox.maxLon)
		.execute()

	return {
		category: query.category,
		categoryID,
		rows: rows.map((r) => ({ name: r.name, latitude: Number(r.latitude), longitude: Number(r.longitude) })),
	}
}
