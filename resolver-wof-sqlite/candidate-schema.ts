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
	/** `-log10(population + 1)` — ASC order = highest-population first. 0 for postcodes (no
population). */
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

/** DDL for the code dictionaries + the staging table — created before the build's load passes. */
export const CANDIDATE_STAGE_DDL = /* sql */ `
CREATE TABLE country_codes (id INTEGER PRIMARY KEY, code TEXT UNIQUE);
CREATE TABLE placetype_codes (id INTEGER PRIMARY KEY, placetype TEXT UNIQUE);
CREATE TABLE cand_stage (
	name_key TEXT, country_id INTEGER, region_id INTEGER, placetype_id INTEGER,
	neg_rank REAL, spr_id INTEGER, name TEXT, latitude REAL, longitude REAL,
	min_lat REAL, min_lon REAL, max_lat REAL, max_lon REAL, population INTEGER, is_primary INTEGER
);
`

/** DDL for the clustered `WITHOUT ROWID` lookup table — created after staging, before the VACUUM. */
export const CANDIDATE_TABLE_DDL = /* sql */ `
CREATE TABLE candidate (
	name_key TEXT NOT NULL, country_id INTEGER NOT NULL, region_id INTEGER NOT NULL,
	placetype_id INTEGER NOT NULL, neg_rank REAL NOT NULL, spr_id INTEGER NOT NULL,
	name TEXT, latitude REAL, longitude REAL, min_lat REAL, min_lon REAL, max_lat REAL, max_lon REAL,
	population INTEGER, is_primary INTEGER,
	PRIMARY KEY (name_key, country_id, region_id, placetype_id, neg_rank, spr_id)
) WITHOUT ROWID;
`
