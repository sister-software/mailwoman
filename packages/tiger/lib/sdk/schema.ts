/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { sql, type Kysely } from "kysely"

/**
 * Re-exports Kysely's `Generated` column marker alongside the table types,
 * so schema consumers need not import Kysely for it.
 */
export { type Generated } from "kysely"

/**
 * The Kysely row type for `tabblock20`, one row per 2020 Census tabulation block
 * with its geography codes, counts and geometry.
 */
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
 * The Kysely row type for `pl_block`, one row per tabulation block from the 2020 P.L.
 * 94-171 tables P2 and H1, keyed on the same `GEOID` as {@link TIGERBlockTable}.
 * The eight race and ethnicity columns partition `pop_total`.
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

	/**
	 * Total housing units in the block, from P.L. 94-171 table H1.
	 */
	housing_units: number

	/**
	 * Occupied housing units from table H1.
	 *
	 * `occupied + vacant` always equals `housing_units`, because the reader refuses any row where it does not.
	 */
	occupied: number

	/**
	 * Vacant housing units from table H1.
	 */
	vacant: number
}

/**
 * Kysely row type for `tiger_streets` (addrfeat — named street segments + ZIPs, per county).
 */
export interface TIGERStreetTable {
	linearid: string
	fullname: string
	zipl: string | null
	zipr: string | null
	statefp: string
}

/**
 * Kysely row type for `tiger_places` (place — incorporated/census places, per state).
 */
export interface TIGERPlaceTable {
	geoid: string
	name: string
	statefp: string
	lsad: string | null
	namelsad: string | null
	classfp: string | null
}

/**
 * The tiger database schema, for `new DatabaseClient<TIGERDatabase>(...)`.
 */
export interface TIGERDatabase {
	tabblock20: TIGERBlockTable
	pl_block: PLBlockTable
	tiger_streets: TIGERStreetTable
	tiger_places: TIGERPlaceTable
}

/**
 * The build-tuning pragmas to execute before {@link initializeTIGERSchema},
 * since `page_size` and `auto_vacuum` take effect only on an empty database.
 */
export const TIGER_PRAGMAS = `
PRAGMA auto_vacuum = INCREMENTAL;
PRAGMA page_size = 4096;
PRAGMA cache_size = 10000;
PRAGMA journal_mode = WAL;
`

async function assertPLBlockShape(db: Kysely<TIGERDatabase>): Promise<void> {
	const columns = await sql<{ name: string }>`select name from pragma_table_info('pl_block')`.execute(db)
	const names = new Set(columns.rows.map((row) => row.name))

	for (const required of ["housing_units", "occupied", "vacant"]) {
		if (!names.has(required)) {
			throw new Error(
				`pl_block predates its H1 columns (missing ${required}). It is a derived table: drop it and re-run \`mailwoman tiger redistricting\` for each state, which reloads P2 and H1 together.`
			)
		}
	}
}

/**
 * Creates the TIGER tables and indexes if they do not exist.
 *
 * It throws when an existing `pl_block` lacks the H1 housing columns,
 * because that derived table must be dropped and reloaded.
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
		.addColumn("housing_units", "integer", (c) => c.notNull())
		.addColumn("occupied", "integer", (c) => c.notNull())
		.addColumn("vacant", "integer", (c) => c.notNull())

		.modifyEnd(sql`without rowid`)
		.execute()

	await assertPLBlockShape(db)

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
