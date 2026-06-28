/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   TIGER SQLite schema, as a string so it loads in both `tsx` source mode and the compiled CLI
 *   (`tsc` doesn't copy `.sql` assets into `out/`). Geometry is GeoJSON text — NOT SpatiaLite. The
 *   prior SpatiaLite path (`load_extension` of a hardcoded macOS dylib + WKB `GEOM` columns) never
 *   loaded on Linux; plain text keeps the build dependency-free and `node:sqlite`-native (read it
 *   back with `JSON.parse`).
 */

import { sql, type Generated, type Kysely } from "kysely"

/** Kysely row type for `tabblock20`. Geometry is a GeoJSON string. */
export interface TIGERBlockTable {
	GEOID: string
	state_code: string
	county_code: string
	tract_code: string
	block_group_code: string
	block_code: string
	urbanized_area_code: string | null
	urban_rural_code: string | null
	housing_unit_count: number
	land_area_sqm: number
	water_area_sqm: number
	population: number
	geometry: string
}

/**
 * Kysely row type for `pl_block` — Census 2020 P.L. 94-171 table P2 (Hispanic-or-Latino by race), one row per
 * tabulation block, keyed on the same 15-char `GEOID` as {@link TIGERBlockTable}. The eight category columns partition
 * `pop_total`.
 */
export interface PLBlockTable {
	GEOID: string
	pop_total: number
	hispanic: number
	white: number
	black: number
	aian: number
	asian: number
	nhpi: number
	other: number
	multi: number
}

/** Kysely row type for `tiger_streets` (ADDRFEAT — named street segments + ZIPs, per county). */
export interface TIGERStreetTable {
	linearid: string
	fullname: string
	zipl: string | null
	zipr: string | null
	statefp: string
}

/** Kysely row type for `tiger_places` (PLACE — incorporated/census places, per state). */
export interface TIGERPlaceTable {
	geoid: string
	name: string
	statefp: string
	lsad: string | null
	namelsad: string | null
	classfp: string | null
}

/** The TIGER database schema, for `new DatabaseClient<TIGERDatabase>(...)`. */
export interface TIGERDatabase {
	tabblock20: TIGERBlockTable
	pl_block: PLBlockTable
	tiger_streets: TIGERStreetTable
	tiger_places: TIGERPlaceTable
}

/** Marker so callers can opt into `Generated` columns later without importing kysely here. */
export type { Generated }

/**
 * Build-tuning PRAGMAs, run raw before any table is created (`page_size`/`auto_vacuum` only take effect on an empty DB,
 * and PRAGMA has no Kysely builder). The consumer execs this, then calls {@link initializeTIGERSchema} for the tables +
 * indexes.
 */
export const TIGER_PRAGMAS = /* sql */ `
PRAGMA auto_vacuum = INCREMENTAL;
PRAGMA page_size = 4096;
PRAGMA cache_size = 10000;
PRAGMA journal_mode = WAL;
`

/**
 * Create the TIGER tables + indexes via the Kysely schema-builder (the house idiom). Idempotent (`IF NOT EXISTS`). Pass
 * a {@link DatabaseClient} (or any `Kysely`) over the TIGER DB; run {@link TIGER_PRAGMAS} first. `us_state`/`tract`
 * aren't in {@link TIGERDatabase} (created here but not queried via Kysely) — `createTable` takes any table name, so
 * that's fine.
 *
 * The `text(N)` length hints in the prior raw DDL were documentary only (SQLite uses TEXT affinity regardless); the
 * lengths live on the {@link TIGERBlockTable} interface instead.
 */
export async function initializeTIGERSchema(db: Kysely<TIGERDatabase>): Promise<void> {
	await db.schema
		.createTable("us_state")
		.ifNotExists()
		.addColumn("state_code", "text", (c) => c.primaryKey().notNull())
		.addColumn("abbreviation", "text", (c) => c.notNull())
		.addColumn("display_name", "text", (c) => c.notNull())
		.addColumn("geometry", "text", (c) => c.notNull())
		.execute()

	await db.schema
		.createTable("tract")
		.ifNotExists()
		.addColumn("GEOID", "text", (c) => c.primaryKey().notNull())
		.addColumn("state_code", "text", (c) => c.notNull())
		.addColumn("county_code", "text", (c) => c.notNull())
		.addColumn("tract_code", "text", (c) => c.notNull())
		.addColumn("geometry", "text", (c) => c.notNull())
		.execute()

	await db.schema
		.createTable("tabblock20")
		.ifNotExists()
		.addColumn("GEOID", "text", (c) => c.primaryKey().notNull())
		.addColumn("state_code", "text", (c) => c.notNull())
		.addColumn("county_code", "text", (c) => c.notNull())
		.addColumn("tract_code", "text", (c) => c.notNull())
		.addColumn("block_group_code", "text", (c) => c.notNull())
		.addColumn("block_code", "text", (c) => c.notNull())
		.addColumn("urbanized_area_code", "text")
		.addColumn("urban_rural_code", "text")
		.addColumn("housing_unit_count", "integer", (c) => c.notNull())
		.addColumn("land_area_sqm", "integer", (c) => c.notNull())
		.addColumn("water_area_sqm", "integer", (c) => c.notNull())
		.addColumn("population", "integer", (c) => c.notNull())
		.addColumn("geometry", "text", (c) => c.notNull())
		.execute()

	// No index on GEOID alone — it's the PRIMARY KEY, which already carries a unique index. The prior
	// schema's idx_tabblock20_geoid duplicated that for nothing (double insert cost, double footprint).
	await db.schema.createIndex("idx_tabblock20_state_code").ifNotExists().on("tabblock20").column("state_code").execute()
	await db.schema
		.createIndex("idx_tabblock20_state_county")
		.ifNotExists()
		.on("tabblock20")
		.columns(["state_code", "county_code"])
		.execute()
	await db.schema
		.createIndex("idx_tabblock20_state_county_tract")
		.ifNotExists()
		.on("tabblock20")
		.columns(["state_code", "county_code", "tract_code"])
		.execute()
	await db.schema.createIndex("idx_tabblock20_population").ifNotExists().on("tabblock20").column("population").execute()

	await db.schema
		.createTable("pl_block")
		.ifNotExists()
		.addColumn("GEOID", "text", (c) => c.primaryKey().notNull())
		.addColumn("pop_total", "integer", (c) => c.notNull())
		.addColumn("hispanic", "integer", (c) => c.notNull())
		.addColumn("white", "integer", (c) => c.notNull())
		.addColumn("black", "integer", (c) => c.notNull())
		.addColumn("aian", "integer", (c) => c.notNull())
		.addColumn("asian", "integer", (c) => c.notNull())
		.addColumn("nhpi", "integer", (c) => c.notNull())
		.addColumn("other", "integer", (c) => c.notNull())
		.addColumn("multi", "integer", (c) => c.notNull())
		// pl_block is small (no geometry) and always probed by its GEOID PK (1:1 join to tabblock20), so
		// cluster it WITHOUT ROWID — one B-tree probe per join, no separate rowid + PK-index pair.
		.modifyEnd(sql`without rowid`)
		.execute()

	await db.schema
		.createTable("tiger_streets")
		.ifNotExists()
		.addColumn("linearid", "text", (c) => c.notNull())
		.addColumn("fullname", "text", (c) => c.notNull())
		.addColumn("zipl", "text")
		.addColumn("zipr", "text")
		.addColumn("statefp", "text", (c) => c.notNull())
		.execute()
	await db.schema.createIndex("idx_tiger_streets_statefp").ifNotExists().on("tiger_streets").column("statefp").execute()
	await db.schema
		.createIndex("idx_tiger_streets_linearid")
		.ifNotExists()
		.on("tiger_streets")
		.column("linearid")
		.execute()

	await db.schema
		.createTable("tiger_places")
		.ifNotExists()
		.addColumn("geoid", "text", (c) => c.notNull())
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("statefp", "text", (c) => c.notNull())
		.addColumn("lsad", "text")
		.addColumn("namelsad", "text")
		.addColumn("classfp", "text")
		.execute()
	await db.schema.createIndex("idx_tiger_places_statefp").ifNotExists().on("tiger_places").column("statefp").execute()
	await db.schema.createIndex("idx_tiger_places_geoid").ifNotExists().on("tiger_places").column("geoid").execute()
}
