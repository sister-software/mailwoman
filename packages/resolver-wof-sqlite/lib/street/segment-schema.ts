/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema for the tiger street-segment interpolation extracts (`street-segments-<cc>-<st>.db`,
 *   built by `scripts/build-interpolation-extract.ts` from tiger edges). This is the Method-3
 *   fallback the resolver drops to when the address-point tier (Method 2) cannot bracket. It is the
 *   definition of the columns the builder writes and the reader ({@link StreetInterpolator}) probes,
 *   so a column rename in one is a compile error in the other.
 *
 *   The builder reads geometry from shapefiles via DuckDB's spatial extension (raw `ST_Read`, see
 *   agents.md "Database / inline SQL") and writes here through `node:sqlite`. The hot positional
 *   insert (a county's worth of edges) stays raw, and its column list derives from
 *   {@link STREET_SEGMENT_COLUMNS} so it cannot drift from the DDL.
 */

import type { Kysely } from "kysely"

import type { RouteKey } from "#street/normalize"

/**
 * One tiger street-segment edge: a `(from_hn, to_hn)` house-number range on one `side`
 * of a named street, with the geometry the interpolator walks.
 *
 * `min_hn`/`max_hn` are the sorted bounds the probe filters on, and `parity` is `odd`, `even` or `mixed`.
 */
export interface StreetSegmentTable {
	/**
	 * `canonicalizeRouteKey(normalizeStreetForKey(street))`, the build/query-consistent probe key.
	 *
	 * The column name says `street_norm`, but the value carries the route fold on top
	 * of the street fold, which is why the brand is {@link RouteKey}.
	 * Builder and probe both apply both folds, and a plain street key bound here
	 * misses every numbered-route row.
	 */
	street_norm: RouteKey
	/**
	 * `L` or `R`, the tiger side the address range sits on.
	 */
	side: string
	from_hn: number
	to_hn: number
	/**
	 * Sorted lower bound of `(from_hn, to_hn)`.
	 * The probe filters `min_hn <= n <= max_hn`.
	 */
	min_hn: number
	/**
	 * Sorted upper bound of `(from_hn, to_hn)`.
	 */
	max_hn: number
	/**
	 * `odd`, `even` or `mixed`, the house-number parity along the range.
	 */
	parity: string
	postcode: string | null
	/**
	 * 5-digit state+county FIPS the edge came from.
	 */
	county_fips: string
	/**
	 * The street as it appeared in tiger (kept for display / debugging).
	 */
	street_raw: string
	/**
	 * GeoJSON LineString text without SpatiaLite.
	 * Read back with `JSON.parse`.
	 */
	geometry: string
	/**
	 * Provenance: the dataset this edge came from (e.g. `tiger:edges`).
	 */
	source: string
	/**
	 * The pinned tiger release the edge was ingested from.
	 */
	release: string
}

/**
 * The extract's single-row calibration metadata: the conformal radius multiplier
 * is a property of the calibration set the artifact was built against,
 * so it ships in the artifact rather than in caller code.
 *
 * See the pair-index precedent in `neural/pair-index-resolver.ts`.
 *
 * Written once by the builder, and read at open time by {@link StreetInterpolator}.
 *
 * Extracts built before this table exists lack it.
 * The reader degrades to `undefined`, and callers fall back to the in-code per-region table.
 * Shipped DBs are rebuilt rather than patched.
 */
export interface InterpCalibrationRow {
	/**
	 * Conformal multiplier for the raw half-segment `uncertainty_m` radius, ×Q̂ for a ~90% bound.
	 */
	radius_multiplier: number
	/**
	 * Provenance of the multiplier (e.g. `split-conformal:2026-06-14`).
	 */
	method: string
	/**
	 * The calibration-table key the multiplier was selected by
	 * (a USPS region code, or `default` for unmeasured).
	 */
	region: string
}

/**
 * The street-segment database schema for `new DatabaseClient<StreetSegmentDatabase>(...)`.
 */
export interface StreetSegmentDatabase {
	street_segment: StreetSegmentTable
	interp_calibration: InterpCalibrationRow
}

/**
 * The `street_segment` columns in insert order.
 *
 * The builder's positional prepared statement derives its placeholder list from this,
 * so the positional order can't drift from the DDL / the reader.
 */
export const STREET_SEGMENT_COLUMNS = [
	"street_norm",
	"side",
	"from_hn",
	"to_hn",
	"min_hn",
	"max_hn",
	"parity",
	"postcode",
	"county_fips",
	"street_raw",
	"geometry",
	"source",
	"release",
] as const

/**
 * Create the `street_segment` table, called before the streaming bulk load.
 */
export async function createStreetSegmentTable(db: Kysely<StreetSegmentDatabase>): Promise<void> {
	await db.schema
		.createTable("street_segment")
		.addColumn("street_norm", "text", (c) => c.notNull())
		.addColumn("side", "text", (c) => c.notNull())
		.addColumn("from_hn", "integer", (c) => c.notNull())
		.addColumn("to_hn", "integer", (c) => c.notNull())
		.addColumn("min_hn", "integer", (c) => c.notNull())
		.addColumn("max_hn", "integer", (c) => c.notNull())
		.addColumn("parity", "text", (c) => c.notNull())
		.addColumn("postcode", "text")
		.addColumn("county_fips", "text", (c) => c.notNull())
		.addColumn("street_raw", "text", (c) => c.notNull())
		.addColumn("geometry", "text", (c) => c.notNull())
		.addColumn("source", "text", (c) => c.notNull())
		.addColumn("release", "text", (c) => c.notNull())
		.execute()
}

/**
 * Create and populate the single-row `interp_calibration` metadata table (see {@link InterpCalibrationRow}).
 *
 * Called once by the extract builder, after the value is selected from the calibration source of record.
 *
 * Build-time only, so async Kysely is fine here.
 * The read side is the raw sync probe in {@link StreetInterpolator}'s constructor,
 * per the sync-by-interface doctrine.
 */
export async function writeInterpCalibration(
	db: Kysely<StreetSegmentDatabase>,
	row: InterpCalibrationRow
): Promise<void> {
	await db.schema
		.createTable("interp_calibration")
		.addColumn("radius_multiplier", "real", (c) => c.notNull())
		.addColumn("method", "text", (c) => c.notNull())
		.addColumn("region", "text", (c) => c.notNull())
		.execute()

	await db.insertInto("interp_calibration").values(row).execute()
}

/**
 * Create the two probe indexes the reader relies on (postcode-scope, street-scope).
 */
export async function createStreetSegmentIndexes(db: Kysely<StreetSegmentDatabase>): Promise<void> {
	await db.schema
		.createIndex("idx_seg_postcode")
		.on("street_segment")
		.columns(["postcode", "street_norm", "min_hn"])
		.execute()

	await db.schema.createIndex("idx_seg_street").on("street_segment").columns(["street_norm", "min_hn"]).execute()
}
