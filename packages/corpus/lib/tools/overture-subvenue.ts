/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Read selected Overture Places categories from `poi.db` and return candidate sub-venue names with
 * country and category provenance.
 *
 * `poi.db` covers four countries — US, CA, FR and MX — so a zero count here is absence in four countries rather
 * than evidence of absence in the world, and every non-Latin designator comes from the OSM leg.
 */

import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

import type { SubVenueHarvestRow } from "#tools/sub/venue/lexicon"

/**
 * Overture categories selected for sub-venue designator evidence.
 */
export const OVERTURE_SUBVENUE_CATEGORIES: Readonly<Record<string, string>> = {
	airport_terminal: "terminal",
	campus_building: "campus",
	pier: "pier",
	airport_lounge: "terminal",
}

/**
 * Read-only subset of POI database tables used by this extractor.
 */
interface POIReadDatabase {
	poi: {
		category_id: number
		name: string | null
		country: string
	}
	poi_category_codes: {
		id: number
		category: string
	}
	layer_manifest: {
		name: string
		source_vintage: string
	}
}

/**
 * Read the Overture release recorded in the POI layer manifest.
 */
export async function readOvertureLayerVintage(databasePath: PathBuilderLike): Promise<string> {
	using kdb = new DatabaseClient<POIReadDatabase>(databasePath, { readOnly: true })

	const row = await kdb
		.selectFrom("layer_manifest")
		.select("source_vintage")
		.where("name", "=", "poi")
		.executeTakeFirst()

	return row?.source_vintage ?? ""
}

export interface ReadOvertureSubVenuesOptions {
	/**
	 * Path to `poi.db`.
	 */
	databasePath: PathBuilderLike
	/**
	 * Category-to-designator mapping.
	 */
	categories?: Readonly<Record<string, string>>
	/**
	 * Optional ISO alpha-2 country filter.
	 */
	countries?: readonly string[]
}

/**
 * Overture sub-venue row with its country and category provenance.
 */
export interface OvertureSubVenueRow extends SubVenueHarvestRow {
	/**
	 * ISO alpha-2 code from the Overture partition.
	 */
	country: string
	/**
	 * Overture category used to select the row.
	 */
	category: string
}

/**
 * Read named POI rows in selected sub-venue categories, optionally filtered by country.
 */
export async function readOvertureSubVenues(options: ReadOvertureSubVenuesOptions): Promise<OvertureSubVenueRow[]> {
	const categories = options.categories ?? OVERTURE_SUBVENUE_CATEGORIES

	using kdb = new DatabaseClient<POIReadDatabase>(options.databasePath, { readOnly: true })

	const codes = await kdb
		.selectFrom("poi_category_codes")
		.select(["id", "category"])
		.where("category", "in", Object.keys(categories))
		.execute()

	if (!codes.length) return []

	const designatorByID = new Map<number, string>()
	const categoryByID = new Map<number, string>()

	for (const code of codes) {
		const designator = categories[code.category]

		if (!designator) continue
		designatorByID.set(code.id, designator)
		categoryByID.set(code.id, code.category)
	}

	let query = kdb
		.selectFrom("poi")
		.select(["category_id", "name", "country"])
		.where("category_id", "in", [...designatorByID.keys()])
		.where("name", "is not", null)

	if (options.countries?.length) {
		query = query.where("country", "in", [...options.countries])
	}

	const rows = await query.execute()

	return rows.map((row) => ({
		designatorID: designatorByID.get(row.category_id)!,
		name: row.name,
		country: row.country,
		category: categoryByID.get(row.category_id)!,
	}))
}
