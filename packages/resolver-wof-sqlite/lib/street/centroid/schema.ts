/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Schema for the street-centroid extract, which groups the address-point extract by street.
 */

import type { Kysely } from "kysely"

import type { NameKey, StreetKey } from "#street/normalize"

/**
 * One row per street, postcode and commune.
 *
 * The tuple `(street_norm, postcode, locality_base)` is unique.
 * The reader combines rows by `SUM(lat * point_count) / SUM(point_count)` to get a
 * street's centroid across every postcode and arrondissement it spans.
 *
 * It converts the bounding-box diagonal from the `min_*` and `max_*` columns into `uncertainty_m`.
 */
export interface StreetCentroidTable {
	/**
	 * The street key from `normalizeStreetForKeyLocale`, which both the builder and the reader use.
	 */
	street_norm: StreetKey
	/**
	 * The postcode of this group, or null when the source row has none.
	 */
	postcode: string | null
	/**
	 * The commune key with any arrondissement removed.
	 *
	 * BAN stores Paris, Lyon and Marseille per arrondissement, but a query usually gives the base commune.
	 * The reader uses this column when the query has no postcode.
	 */
	locality_base: NameKey
	/**
	 * The mean latitude of the group's member address points.
	 */
	lat: number
	/**
	 * The mean longitude of the group's member address points.
	 */
	lon: number
	min_lat: number
	max_lat: number
	min_lon: number
	max_lon: number
	/**
	 * The number of member address points, which weights the cross-row centroid.
	 */
	point_count: number
	/**
	 * One street name as it appeared in the source, kept for display and debugging.
	 */
	street_raw: string
	/**
	 * The source register, such as `ban:fr`.
	 */
	source: string
	/**
	 * The data release that the member points came from.
	 */
	release: string
	/**
	 * The value of `foldStreetSurface(street_raw)`, used by {@link StreetLocalityEvidence}
	 * to check that a street name exists.
	 *
	 * The name-evidence rerank folds the model's street text with the same function, so this
	 * column must use `foldStreetSurface` and must not follow the `street_norm` normalizer.
	 * The type is a plain string because `foldStreetSurface` differs from the
	 * {@link NameKey} fold that other `name_key` columns use.
	 *
	 * Branding it as a `NameKey` would allow a probe with the wrong fold.
	 */
	name_key: string
}

/**
 * The street-centroid database schema for `new DatabaseClient<StreetCentroidDatabase>(...)`.
 */
export interface StreetCentroidDatabase {
	street_centroid: StreetCentroidTable
}

/**
 * The `street_centroid` columns in insert order.
 *
 * The builder derives the placeholders of its positional insert from this list.
 */
export const STREET_CENTROID_COLUMNS = [
	"street_norm",
	"postcode",
	"locality_base",
	"lat",
	"lon",
	"min_lat",
	"max_lat",
	"min_lon",
	"max_lon",
	"point_count",
	"street_raw",
	"source",
	"release",
	"name_key",
] as const

/**
 * Creates the `street_centroid` table before the bulk load.
 */
export async function createStreetCentroidTable(db: Kysely<StreetCentroidDatabase>): Promise<void> {
	await db.schema
		.createTable("street_centroid")
		.addColumn("street_norm", "text", (c) => c.notNull())
		.addColumn("postcode", "text")
		.addColumn("locality_base", "text", (c) => c.notNull())
		.addColumn("lat", "real", (c) => c.notNull())
		.addColumn("lon", "real", (c) => c.notNull())
		.addColumn("min_lat", "real", (c) => c.notNull())
		.addColumn("max_lat", "real", (c) => c.notNull())
		.addColumn("min_lon", "real", (c) => c.notNull())
		.addColumn("max_lon", "real", (c) => c.notNull())
		.addColumn("point_count", "integer", (c) => c.notNull())
		.addColumn("street_raw", "text", (c) => c.notNull())
		.addColumn("source", "text", (c) => c.notNull())
		.addColumn("release", "text", (c) => c.notNull())
		.addColumn("name_key", "text", (c) => c.notNull())
		.execute()
}

/**
 * Creates the postcode and locality indexes that the reader probes, plus `idx_sc_name`.
 *
 * The `idx_sc_name` index serves the unscoped `name_key = ?` lookup,
 * which would otherwise skip-scan `idx_sc_postcode`.
 */
export async function createStreetCentroidIndexes(db: Kysely<StreetCentroidDatabase>): Promise<void> {
	await db.schema.createIndex("idx_sc_postcode").on("street_centroid").columns(["postcode", "street_norm"]).execute()

	await db.schema
		.createIndex("idx_sc_locality")
		.on("street_centroid")
		.columns(["locality_base", "street_norm"])
		.execute()

	await db.schema.createIndex("idx_sc_name").on("street_centroid").columns(["name_key"]).execute()
}
