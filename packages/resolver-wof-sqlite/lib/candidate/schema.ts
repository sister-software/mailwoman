/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { sql, type Kysely } from "kysely"

import type { CandidateAncestorsDatabase } from "#candidate/ancestors/schema"
import type { CapitalTable } from "#capital-schema"
import type { NameKey } from "#street/normalize"

/**
 * One candidate row; `name_key` plus the four small int keys, `neg_rank` and `spr_id` form the clustered primary key, and the rest is denormalized so a resolve is one probe.
 */
export interface CandidateTable {
	/**
	 * The shared {@link normalizeLocalityForKey} of the name/alias — the probe key.
	 */
	name_key: NameKey
	/**
	 * Small int from {@link CountryCodeTable} (shrinks the clustered key).
	 */
	country_id: number
	/**
	 * The place's region-tier ancestor id, or 0.
	 */
	region_id: number
	/**
	 * Small int from {@link PlacetypeCodeTable}.
	 */
	placetype_id: number
	/**
	 * `-log10(population + 1)`; ASC order puts the highest population first, and postcodes carry 0.
	 */
	neg_rank: number
	/**
	 * WOF id of the place this row resolves to.
	 */
	spr_id: number
	name: string | null
	latitude: number | null
	longitude: number | null
	min_lat: number | null
	min_lon: number | null
	max_lat: number | null
	max_lon: number | null
	population: number | null
	/**
	 * 1 when the row is the place's canonical name (vs an alias/abbrev).
	 */
	is_primary: number | null
	/**
	 * Blended place importance in [0, 1], NULL when unmeasured (never zero) and copied verbatim from the pre-split score source, not the split `encyclopedic` channel.
	 */
	importance: number | null
	/**
	 * The name's detected role on this row (`'abbr'`, `'gloss'` or `'variant'`), or NULL when no role was detected; the column is write-only in this build generation.
	 */
	name_role: string | null
}

/**
 * `(id → ISO country code)` dictionary.
 */
export interface CountryCodeTable {
	id: number
	code: string
}

/**
 * `(id → placetype)` dictionary.
 */
export interface PlacetypeCodeTable {
	id: number
	placetype: string
}

/**
 * The candidate database schema, extending the ancestors sidecar so one typed client covers every table in the artifact.
 */
export interface CandidateDatabase extends CandidateAncestorsDatabase {
	/**
	 * The clustered `without rowid` lookup table the reader probes.
	 */
	candidate: CandidateTable
	/**
	 * Transient staging table (same columns); dropped once `candidate` is materialized.
	 */
	cand_stage: CandidateTable
	country_codes: CountryCodeTable
	placetype_codes: PlacetypeCodeTable
	/**
	 * The capital-status reference carried in-artifact; see capital-schema.ts.
	 */
	capital: CapitalTable
}

/**
 * The `candidate`/`cand_stage` columns in clustered-key order, from which the materialization derives its column list; keep in sync with {@link CandidateTable}.
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
	// Appended, never inserted mid-list: the positional `insert into cand_stage values (…)` binds by position.
	"importance",
	"name_role",
] as const

/**
 * Create the code dictionaries and the transient staging table; `cand_stage` mirrors {@link CandidateTable} with every column nullable because the loader fills them positionally.
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
		.addColumn("importance", "real")
		.addColumn("name_role", "text")
		.execute()
}

/**
 * Create the clustered `without rowid` lookup table, whose first six columns form the primary key (population-ranked via `neg_rank`).
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
		.addColumn("importance", "real")
		.addColumn("name_role", "text")
		.addPrimaryKeyConstraint("candidate_pk", [
			"name_key",
			"country_id",
			"region_id",
			"placetype_id",
			"neg_rank",
			"spr_id",
		])
		// `without rowid` has no first-class builder. The raw modifier is the idiomatic fallback.
		.modifyEnd(sql`without rowid`)
		.execute()
}
