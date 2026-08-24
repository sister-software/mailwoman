/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema for the byte-range CANDIDATE gazetteer (`candidate.db`) — the single source of truth
 *   for the columns shared by the BUILDER ({@link buildCandidateTable}) and the READERS (the Node
 *   {@link WOFCandidateTableLookup} + the browser `httpvfs-resolver.ts`). Before this module each
 *   side hand-wrote the column list; a rename in one place broke the other at runtime. Now the
 *   contract is a Kysely `Database` interface (`new DatabaseClient<CandidateDatabase>(...)` for
 *   typed inserts) plus the table DDL as strings — so a column change is a compile error on every
 *   consumer.
 *
 *   `cand_stage` is the transient staging table the builder bulk-loads; `candidate` is the clustered
 *   `WITHOUT ROWID` B-tree it's materialized into (same columns). The reader queries `candidate`.
 */

import { sql, type Kysely } from "kysely"

import type { CandidateAncestorsDatabase } from "./candidate-ancestors-schema.ts"
import type { CapitalTable } from "./capital-schema.ts"
import type { NameKey } from "./street-normalize.ts"

/**
 * One candidate row. `name_key` + the four small int keys + `neg_rank` + `spr_id` form the clustered primary key; the
 * rest is denormalized so a resolve is one probe (no join to `spr`). Coordinates + bbox + name are nullable at the SQL
 * level (a postcode shard row may lack a bbox).
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
	 * The place's region-tier ancestor id, or 0 (carried for the future region 2-step).
	 */
	region_id: number
	/**
	 * Small int from {@link PlacetypeCodeTable}.
	 */
	placetype_id: number
	/**
	 * `-log10(population + 1)` — ASC order = highest-population first. 0 for postcodes (no population).
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
	 * Blended place importance in [0, 1] — the toponym-fame prior the bare-city-name class is decided on (#28). NULL
	 * means the score source had no row for this place: UNMEASURED, never "an importance of zero" (meaning-of-zero).
	 * Constant across every row of one place — primary, alias and abbrev alike — because it is a property of the PLACE,
	 * not of the name that reached it, which is what lets a bare `Moscow` inherit Москва's score through the alias row.
	 *
	 * **THIS IS THE PRE-SPLIT CONFLATION, AND THE NAME SAYS SO.** It is `place_importance.importance` copied verbatim
	 * from the score source — the bounded blend `place-importance-schema.ts`'s `blendImportance` writes (the
	 * concordance's encyclopedia-derived channel clamped around a population-derived base); that module calls the column
	 * DEPRECATED. It is NOT the split `encyclopedic` channel, and the two must not be conflated in a future build:
	 * writing the split value here instead was measured on 2026-08-10 and makes the ranking key INERT on three of the
	 * four rows it exists to fix. The reason is coverage, not principle — the encyclopedia-concordance join in
	 * `admin-global-priority-importance.db` reaches 133,888 of 702,709 scored places and only eleven countries
	 * (US/FR/GB/DE/IT/ES/NL/JP/CN/KR/TW). CA, AU and RU have ZERO concordance rows, so Whitby CA, Windsor CA and Epping
	 * AU carry the population fallback and nothing else. Under the strict split those three become unmeasured, the
	 * consumer's positive-evidence-only rule leaves them exactly where population put them (first), and the famous GB
	 * bearer can never overtake them. The conflated column is the only one on which every bearer of a name is scored on a
	 * single comparable scale, which is the precondition for comparing them at all.
	 *
	 * So a consumer reads this as "fame, with population standing in where fame was never measured" — the legacy blended
	 * semantics — and NOT as "this place has an encyclopedia entry of this importance". When the score source grows a
	 * real `encyclopedic` column for every country, add a SECOND column rather than redefining this one.
	 */
	importance: number | null
	/**
	 * The NAME'S detected role on this row, or NULL (#1730). Two build-time detectors stamp `is_primary = 0` rows only:
	 *
	 * - `'abbr'` — provenance-based: the surface is a WOF `variant` name in one of the place's country's official languages
	 *   (or English) — the #936 signal, measured at a 13× key-collision rate vs preferred names.
	 * - `'gloss'` — anomaly-based: the row belongs to a place whose key count crosses the gloss threshold with a non-admin
	 *   placetype and NO measured prominence (population absent AND importance unmeasured) — the translation-gloss
	 *   fingerprint (#1730's sweep; `Poisson` → a US fish-name place). Provenance CANNOT separate a gloss from an exonym
	 *   (WOF imported both as `x_preferred`), which is why this detector is an anomaly test and stamps only the certain
	 *   core.
	 *
	 * NULL = no role detected. The column is WRITE-ONLY in this build generation: no ranking consumer reads it — a rank
	 * penalty is its own future, D-rule-gated step with the `gloss_key` board as tripwire.
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
 * The candidate database schema for `new DatabaseClient<CandidateDatabase>(...)`. Extends the ancestors sidecar
 * (`candidate_ancestor` + `candidate_interval` — see candidate-ancestors-schema.ts for the encoding decision), so the
 * builder's one typed client covers every table in the artifact.
 */
export interface CandidateDatabase extends CandidateAncestorsDatabase {
	/**
	 * The clustered `WITHOUT ROWID` lookup table the reader probes.
	 */
	candidate: CandidateTable
	/**
	 * Transient staging table (same columns); dropped once `candidate` is materialized.
	 */
	cand_stage: CandidateTable
	country_codes: CountryCodeTable
	placetype_codes: PlacetypeCodeTable
	/**
	 * The capital-status reference carried in-artifact (#1880's distribution home) — see capital-schema.ts.
	 */
	capital: CapitalTable
}

/**
 * The `candidate`/`cand_stage` columns in clustered-key order. The materialization `INSERT INTO candidate SELECT … FROM
 * cand_stage` derives its column list from this, so the two tables can't drift. Keep in sync with
 * {@link CandidateTable}.
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
	// Appended, never inserted mid-list: the first six entries ARE the clustered primary key, and the
	// positional `INSERT INTO cand_stage VALUES (…)` in the builder binds by position.
	"importance",
	"name_role",
] as const

/**
 * Create the code dictionaries + the transient staging table — called before the build's load passes. `cand_stage`
 * mirrors {@link CandidateTable} but every column is nullable (the loader fills them positionally). Pass a
 * {@link DatabaseClient} (or any `Kysely`) over the candidate DB.
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
 * Create the clustered `WITHOUT ROWID` lookup table — called after staging, before the VACUUM. The first six columns
 * form the clustered primary key (population-ranked via `neg_rank`).
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
		// `WITHOUT ROWID` has no first-class builder; the raw modifier is the idiomatic fallback.
		.modifyEnd(sql`without rowid`)
		.execute()
}
