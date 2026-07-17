/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema for the DERIVED STREET-CENTROID shard (`street-centroids-<cc>.db`, built by
 *   `ban/scripts/build-street-centroid-shard.ts` — the #1042 street-level tier behind "street-only
 *   FR queries deserve a street-level answer"). The shard is a `GROUP BY street` roll-up of the
 *   sealed rooftop address-point shard: one row per (street, postcode, commune) carrying the street's
 *   CENTROID + bounding-box EXTENT + member-point count. No new data source — a derived artifact.
 *
 *   Single source of truth for the columns shared by the BUILDER (a positional prepared INSERT for
 *   throughput) and the READER ({@link StreetCentroidSqliteLookup}), so a column rename in one is a
 *   compile error in the other — the same discipline as `address-point-schema.ts`.
 *
 *   Probe scopes (most-selective first): by `postcode`, else by `locality_base` (the
 *   arrondissement-stripped commune — see `stripArrondissement`; BAN names Paris/Lyon/Marseille rows
 *   per arrondissement, but a query names the base commune). The reader WEIGHTED-aggregates across the
 *   matched rows (by `point_count`) so a locality-scope probe returns the street's grand centroid over
 *   every postcode/arrondissement it spans.
 */

import type { Kysely } from "kysely"

/**
 * One street roll-up. `(street_norm, postcode, locality_base)` is unique. `lat`/`lon` are the UNWEIGHTED mean of the
 * group's member address points (each source row = one point), so a cross-group weighted mean (`SUM(lat*point_count) /
 * SUM(point_count)`) reconstructs the grand centroid. `min_/max_lat/lon` are the group's extent (the reader turns the
 * bbox diagonal into an honest `uncertainty_m`).
 */
export interface StreetCentroidTable {
	/** Shared `normalizeStreetForKeyLocale` of the street — the build/query-consistent probe key. */
	street_norm: string
	/** The 5-digit postcode of this group, or null when the source row carried none. */
	postcode: string | null
	/** Arrondissement-stripped commune (`stripArrondissement(normalizeLocalityForKey(commune))`) — the fallback scope. */
	locality_base: string
	/** Weighted-mean centroid latitude of the street's member points. */
	lat: number
	/** Weighted-mean centroid longitude of the street's member points. */
	lon: number
	min_lat: number
	max_lat: number
	min_lon: number
	max_lon: number
	/** Member address-point count — the weight for a cross-group centroid aggregate. */
	point_count: number
	/** A representative street name as it appeared in the source (display / debugging). */
	street_raw: string
	/** Provenance: the register this street was derived from (e.g. `ban:fr`). */
	source: string
	/** The pinned data release the underlying points came from. */
	release: string
	/**
	 * #727 phase-4c: `foldStreetSurface(street_raw)` — the contract-fold street-NAME existence key for
	 * {@link StreetLocalityEvidence}. Distinct from `street_norm` (the `street-normalize` geocoding key): the
	 * name-evidence rerank folds the model's street surface with the SAME `foldStreetSurface` used to build this column
	 * (the fold-parity contract), so it must not drift from `street_norm`'s richer normalizer. Indexed (`idx_sc_name`)
	 * for a direct seek.
	 */
	name_key: string
}

/** The street-centroid database schema for `new DatabaseClient<StreetCentroidDatabase>(...)`. */
export interface StreetCentroidDatabase {
	street_centroid: StreetCentroidTable
}

/**
 * The `street_centroid` columns in INSERT order. The builder's positional prepared statement derives its placeholder
 * list from this, so the positional order can't drift from the DDL / the reader.
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

/** Create the `street_centroid` table — called before the streaming bulk load. */
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
 * Create the probe indexes: the two geocoding-scope indexes (postcode, locality-base) the resolver reader relies on,
 * plus `idx_sc_name` — the #727 phase-4c name-existence key for a direct `name_key = ?` seek (the unscoped fragment
 * lookup; without it that query skip-scans `idx_sc_postcode` at ~5 ms/probe).
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
