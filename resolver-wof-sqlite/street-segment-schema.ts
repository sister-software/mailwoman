/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema for the TIGER STREET-SEGMENT interpolation shards (`street-segments-<cc>-<st>.db`,
 *   built by `scripts/build-interpolation-shard.ts` from TIGER EDGES) — the #483 Method-3 fallback
 *   the resolver drops to when the address-point tier (Method 2) can't bracket. Single source of
 *   truth for the columns the BUILDER writes and the READER ({@link StreetInterpolator}) probes, so
 *   a column rename in one is a compile error in the other.
 *
 *   The builder reads geometry from shapefiles via DuckDB's spatial extension (raw `ST_Read` — see
 *   AGENTS.md "Database / inline SQL") and writes here through `node:sqlite`. The hot positional
 *   INSERT (a county's worth of edges) stays raw; its column list is derived from
 *   {@link STREET_SEGMENT_COLUMNS} so it can't drift from the DDL.
 */

import type { Kysely } from "kysely"

/**
 * One TIGER street-segment edge: a `(from_hn, to_hn)` house-number range on one `side` of a named street, with the
 * geometry the interpolator walks. `min_hn`/`max_hn` are the sorted bounds (the probe filters on them); `parity` is
 * `odd`/`even`/`mixed`.
 */
export interface StreetSegmentTable {
	/** Shared {@link normalizeStreetForKey} of the street — the build/query-consistent probe key. */
	street_norm: string
	/** `L` or `R` — the TIGER side the address range sits on. */
	side: string
	from_hn: number
	to_hn: number
	/** Sorted lower bound of `(from_hn, to_hn)` — the probe filters `min_hn <= n <= max_hn`. */
	min_hn: number
	/** Sorted upper bound of `(from_hn, to_hn)`. */
	max_hn: number
	/** `odd` | `even` | `mixed` — the house-number parity along the range. */
	parity: string
	postcode: string | null
	/** 5-digit state+county FIPS the edge came from. */
	county_fips: string
	/** The street as it appeared in TIGER (kept for display / debugging). */
	street_raw: string
	/** GeoJSON LineString text (no SpatiaLite — read back with `JSON.parse`). */
	geometry: string
	/** Provenance: the dataset this edge came from (e.g. `tiger:edges`). */
	source: string
	/** The pinned TIGER release the edge was ingested from. */
	release: string
}

/** The street-segment database schema for `new DatabaseClient<StreetSegmentDatabase>(...)`. */
export interface StreetSegmentDatabase {
	street_segment: StreetSegmentTable
}

/**
 * The `street_segment` columns in INSERT order. The builder's positional prepared statement derives its placeholder
 * list from this, so the positional order can't drift from the DDL / the reader.
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

/** Create the `street_segment` table — called before the streaming bulk load. */
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

/** Create the two probe indexes the reader relies on (postcode-scope, street-scope). */
export async function createStreetSegmentIndexes(db: Kysely<StreetSegmentDatabase>): Promise<void> {
	await db.schema
		.createIndex("idx_seg_postcode")
		.on("street_segment")
		.columns(["postcode", "street_norm", "min_hn"])
		.execute()
	await db.schema.createIndex("idx_seg_street").on("street_segment").columns(["street_norm", "min_hn"]).execute()
}
