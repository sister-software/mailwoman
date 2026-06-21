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

import type { Generated } from "kysely"

/** Kysely row type for `tabblock20`. Geometry is a GeoJSON string. */
export interface TIGERBlockTable {
	GEOID: string
	state_code: string
	county_code: string
	county_sub_division_code: string
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

/** The TIGER database schema, for `new DatabaseClient<TIGERDatabase>(...)`. */
export interface TIGERDatabase {
	tabblock20: TIGERBlockTable
}

/** Marker so callers can opt into `Generated` columns later without importing kysely here. */
export type { Generated }

export const TIGER_INITIALIZE_SQL = /* sql */ `
PRAGMA auto_vacuum = INCREMENTAL;
PRAGMA page_size = 4096;
PRAGMA cache_size = 10000;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS "us_state" (
	"state_code" text(2) PRIMARY KEY NOT NULL,
	"abbreviation" text NOT NULL,
	"display_name" text NOT NULL,
	"geometry" text NOT NULL
);

CREATE TABLE IF NOT EXISTS "tract" (
	"GEOID" text(11) PRIMARY KEY NOT NULL,
	"state_code" text(2) NOT NULL,
	"county_code" text(3) NOT NULL,
	"county_sub_division_code" text(5) NOT NULL,
	"tract_code" text(6) NOT NULL,
	"geometry" text NOT NULL
);

CREATE TABLE IF NOT EXISTS "tabblock20" (
	"GEOID" text(15) PRIMARY KEY NOT NULL,
	"state_code" text(2) NOT NULL,
	"county_code" text(3) NOT NULL,
	"county_sub_division_code" text(5) NOT NULL,
	"tract_code" text(6) NOT NULL,
	"block_group_code" text(1) NOT NULL,
	"block_code" text(4) NOT NULL,
	"urbanized_area_code" text(5),
	"urban_rural_code" text(1),
	"housing_unit_count" integer NOT NULL,
	"land_area_sqm" integer NOT NULL,
	"water_area_sqm" integer NOT NULL,
	"population" integer NOT NULL,
	"geometry" text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_tabblock20_geoid" ON "tabblock20" ("GEOID");
CREATE INDEX IF NOT EXISTS "idx_tabblock20_state_code" ON "tabblock20" ("state_code");
CREATE INDEX IF NOT EXISTS "idx_tabblock20_state_county" ON "tabblock20" ("state_code", "county_code");
CREATE INDEX IF NOT EXISTS "idx_tabblock20_state_county_tract" ON "tabblock20" ("state_code", "county_code", "tract_code");
CREATE INDEX IF NOT EXISTS "idx_tabblock20_population" ON "tabblock20" ("population");
`
