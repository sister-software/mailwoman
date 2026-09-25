/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Read selected Overture Places categories from `poi.db` and return candidate sub-venue names with
 * country and category provenance. The category list is restricted to measured designator-bearing
 * subsets. This complements the OSM source and does not represent global coverage.
 *
 *   ── why overture AT all, when the OSM extractor already exists ────────────────────────────────────
 *   Wave 1 measured `concourse` at 21 real Overture rows against 4 in the whole Great Britain OSM
 *   extract, 3 of which are a street called concourse WAY. Overture's `airport_terminal` category is
 *   curated venue-interior naming. OSM's `aeroway=terminal` is a building footprint that usually
 *   carries the airport's name. The two sources fail differently, so both are read.
 *
 *   ── the category SET is measured rather than guessed ────────────────────────────────────────────────────
 *   A full scan of all 13,681,698 rows (2026-08-05, poi.db vintage 2026-05-20.0) counted, per
 *   category, how many named rows carry a designator token. The ranking is not what a category name
 *   predicts — `gas_station` leads the whole table with 12,996 hits, every one of them the token
 *   `station` inside "Holiday Station" / "Chevron Station Seward", and `shoe_store` contributes 708
 *   hits of `wing` because Red Wing sells boots. {@link OVERTURE_SUBVENUE_CATEGORIES} is the four
 *   categories whose hits survived reading the distribution. the rejects are listed below it so nobody
 *   re-proposes them.
 *
 *   ── poi.db is four countries ─────────────────────────────────────────────────────────────────────
 *   Measured the same day: US 11,521,612 / CA 794,418 / FR 721,352 / MX 644,316, and no other country. The
 *   shipped layer is not a world gazetteer, so Overture can attest en-US, en-CA, fr-FR and es-MX
 *   surfaces and no other field. Every non-Latin designator the corpus task asks for — `ターミナル`,
 *   `Halle`, `Flügel` — has to come from the OSM leg. Do not read a zero count here as evidence of
 *   absence in the world. it is evidence of absence in four countries.
 *
 *   ── The row shape fits. the provenance stamp did not ─────────────────────────────────────────────
 *   Wave 1's `OSMSubVenueRow` was written to accept a non-OSM row, and it does: an Overture row is
 *   `{ designatorID, name }` with no `ref` and no `localizedNames`. What did not fit is
 *   `extractAttestedPhrases`, which hardcoded `osm:name` as the surface's `source`. Feeding Overture
 *   rows through it unchanged would have labelled every Overture surface as OSM-attested — a
 *   provenance lie, and under ODbL a consequential one. Hence the `source`/`region` options on that
 *   function and the source-neutral {@link SubVenueHarvestRow} name.
 */

import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

import type { SubVenueHarvestRow } from "#tools/sub/venue/lexicon"

/**
 * Overture categories selected for sub-venue designator evidence.
 */
export const OVERTURE_SUBVENUE_CATEGORIES: Readonly<Record<string, string>> = {
	// Airport terminal structures.
	airport_terminal: "terminal",
	// Campus buildings, halls, and related structures.
	campus_building: "campus",
	// Airport piers.
	pier: "pier",
	// Airport lounges with interior designator names.
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
