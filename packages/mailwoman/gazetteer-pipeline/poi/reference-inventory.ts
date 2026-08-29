/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Read ONE POI class out of an already-sealed POI layer, as the second inventory a capture-recapture
 *   estimate needs. Read-only by construction: the handle is opened `readOnly`, so pointing this at the
 *   shipped `poi.db` cannot reopen or patch it.
 *
 *   The category is named, never numbered. `poi.category_id` is a per-build dictionary code — `pharmacy`
 *   is 72 in the 2026-07-22 build and carries no promise of being 72 in the next one — so the lookup goes
 *   through `poi_category_codes` and REFUSES a class the artifact does not hold. A numeric literal would
 *   read some other class's rows under this class's name, which no downstream check could catch.
 */

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { DatabaseSync } from "@mailwoman/platform/sqlite"
import type { POIDatabase } from "@mailwoman/resolver-wof-sqlite/poi-schema"

import type { BBox } from "./build-poi.ts"

export interface ReferenceInventoryQuery {
	/**
	 * Path to a sealed POI layer database.
	 */
	databasePath: string
	/**
	 * A `poi_category_codes.category` value, e.g. `pharmacy`.
	 */
	category: string
	/**
	 * Coarse pre-clip. Must CONTAIN the region of interest — the caller clips exactly, on the H3 cell set.
	 */
	bbox: BBox
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
 * Every row of `category` inside `bbox`. Throws when the artifact holds no such category.
 */
export async function readReferenceInventory(query: ReferenceInventoryQuery): Promise<ReferenceInventory> {
	const database = new DatabaseSync(query.databasePath, { readOnly: true })

	using db = new DatabaseClient<POIDatabase>({ database })

	const code = await db
		.selectFrom("poi_category_codes")
		.select(["id"])
		.where("category", "=", query.category)
		.executeTakeFirst()

	if (!code) {
		throw new Error(
			`readReferenceInventory: ${query.databasePath} holds no category ${JSON.stringify(query.category)} — ` +
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
