/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema for the byte-range CANDIDATE gazetteer (`candidate.db`) — the single source of truth
 *   for the columns shared by the BUILDER ({@link buildCandidateTable}) and the READERS (the Node
 *   {@link WofCandidateTableLookup} + the browser `httpvfs-resolver.ts`). Before this module each
 *   side hand-wrote the column list; a rename in one place broke the other at runtime. Now the
 *   contract is a Kysely `Database` interface (`new DatabaseClient<CandidateDatabase>(...)` for
 *   typed inserts) plus the table DDL as strings — so a column change is a compile error on every
 *   consumer.
 *
 *   `cand_stage` is the transient staging table the builder bulk-loads; `candidate` is the clustered
 *   `WITHOUT ROWID` B-tree it's materialized into (same columns). The reader queries `candidate`.
 */

import { sql, type Kysely } from "kysely"

/**
 * One candidate row. `name_key` + the four small int keys + `neg_rank` + `spr_id` form the
 * clustered primary key; the rest is denormalized so a resolve is one probe (no join to `spr`).
 * Coordinates + bbox + name are nullable at the SQL level (a postcode shard row may lack a bbox).
 */
export interface CandidateTable {
	/** The shared {@link normalizeLocalityForKey} of the name/alias — the probe key. */
	name_key: string
	/** Small int from {@link CountryCodeTable} (shrinks the clustered key). */
	country_id: number
	/** The place's region-tier ancestor id, or 0 (carried for the future region 2-step). */
	region_id: number
	/** Small int from {@link PlacetypeCodeTable}. */
	placetype_id: number
	/**
	 * `-log10(population + 1)` — ASC order = highest-population first. 0 for postcodes (no
	 * population).
	 */
	neg_rank: number
	/** WOF id of the place this row resolves to. */
	spr_id: number
	name: string | null
	latitude: number | null
	longitude: number | null
	min_lat: number | null
	min_lon: number | null
	max_lat: number | null
	max_lon: number | null
	population: number | null
	/** 1 when the row is the place's canonical name (vs an alias/abbrev). */
	is_primary: number | null
}

/** `(id → ISO country code)` dictionary. */
export interface CountryCodeTable {
	id: number
	code: string
}

/** `(id → placetype)` dictionary. */
export interface PlacetypeCodeTable {
	id: number
	placetype: string
}

/** The candidate database schema for `new DatabaseClient<CandidateDatabase>(...)`. */
export interface CandidateDatabase {
	/** The clustered `WITHOUT ROWID` lookup table the reader probes. */
	candidate: CandidateTable
	/** Transient staging table (same columns); dropped once `candidate` is materialized. */
	cand_stage: CandidateTable
	country_codes: CountryCodeTable
	placetype_codes: PlacetypeCodeTable
}

/**
 * The `candidate`/`cand_stage` columns in clustered-key order. The materialization `INSERT INTO
 * candidate SELECT … FROM cand_stage` derives its column list from this, so the two tables can't
 * drift. Keep in sync with {@link CandidateTable}.
 */
export const CANDIDATE_COLUMNS = [
	"name_key",
	"country_id",
	"region_id",
	"placetype_id",
	"neg_rank",
	"spr_id",
	"name",
	"latitude",
	"longitude",
	"min_lat",
	"min_lon",
	"max_lat",
	"max_lon",
	"population",
	"is_primary",
] as const

/**
 * Create the code dictionaries + the transient staging table — called before the build's load
 * passes. `cand_stage` mirrors {@link CandidateTable} but every column is nullable (the loader fills
 * them positionally). Pass a {@link DatabaseClient} (or any `Kysely`) over the candidate DB.
 */
export async function createCandidateStagingTables(db: Kysely<CandidateDatabase>): Promise<void> {
	await db.schema
		.createTable("country_codes")
		.addColumn("id", "integer", (c) => c.primaryKey())
		.addColumn("code", "text", (c) => c.unique())
		.execute()
	await db.schema
		.createTable("placetype_codes")
		.addColumn("id", "integer", (c) => c.primaryKey())
		.addColumn("placetype", "text", (c) => c.unique())
		.execute()
	await db.schema
		.createTable("cand_stage")
		.addColumn("name_key", "text")
		.addColumn("country_id", "integer")
		.addColumn("region_id", "integer")
		.addColumn("placetype_id", "integer")
		.addColumn("neg_rank", "real")
		.addColumn("spr_id", "integer")
		.addColumn("name", "text")
		.addColumn("latitude", "real")
		.addColumn("longitude", "real")
		.addColumn("min_lat", "real")
		.addColumn("min_lon", "real")
		.addColumn("max_lat", "real")
		.addColumn("max_lon", "real")
		.addColumn("population", "integer")
		.addColumn("is_primary", "integer")
		.execute()
}

/**
 * Create the clustered `WITHOUT ROWID` lookup table — called after staging, before the VACUUM. The
 * first six columns form the clustered primary key (population-ranked via `neg_rank`).
 */
export async function createCandidateTable(db: Kysely<CandidateDatabase>): Promise<void> {
	await db.schema
		.createTable("candidate")
		.addColumn("name_key", "text", (c) => c.notNull())
		.addColumn("country_id", "integer", (c) => c.notNull())
		.addColumn("region_id", "integer", (c) => c.notNull())
		.addColumn("placetype_id", "integer", (c) => c.notNull())
		.addColumn("neg_rank", "real", (c) => c.notNull())
		.addColumn("spr_id", "integer", (c) => c.notNull())
		.addColumn("name", "text")
		.addColumn("latitude", "real")
		.addColumn("longitude", "real")
		.addColumn("min_lat", "real")
		.addColumn("min_lon", "real")
		.addColumn("max_lat", "real")
		.addColumn("max_lon", "real")
		.addColumn("population", "integer")
		.addColumn("is_primary", "integer")
		.addPrimaryKeyConstraint("candidate_pk", [
			"name_key",
			"country_id",
			"region_id",
			"placetype_id",
			"neg_rank",
			"spr_id",
		])
		// `WITHOUT ROWID` has no first-class builder; the raw modifier is the idiomatic fallback.
		.modifyEnd(sql`without rowid`)
		.execute()
}
