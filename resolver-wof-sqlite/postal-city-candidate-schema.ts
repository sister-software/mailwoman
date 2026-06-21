/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema for the POSTAL-CITY CANDIDATE side-index (#741 / #475) — a small `(name_key,
 *   postcode) → geo-locality` table that lives alongside the byte-range `candidate` table so the
 *   candidate-backend resolver (the demo/CLI default) can do what the FTS coordinate-first scorer
 *   does: resolve a user-typed POSTAL city ("Antioch", 37013) to the geographic locality the
 *   postcode sits in ("Nashville").
 *
 *   Why a SIDE-INDEX, not cloned `candidate` rows: the `candidate` B-tree is keyed `(name_key,
 *   country_id, region_id, placetype_id, …)` and ranked population-first — it has no postcode
 *   dimension. A cloned alias row was tested (#741) and falsified: a sentinel rank is
 *   bare-name-safe but then loses to any in-region homonym, and there is no single rank that is
 *   both. The fix is an EXACT `(name_key, postcode)` probe that bypasses population/region ranking
 *   entirely — consulted only when the query carries a postcode, so the common no-postcode path is
 *   untouched.
 */

import { sql, type Kysely } from "kysely"

/**
 * One postal-city → geo-locality edge, keyed exactly by `(name_key, postcode)`. The probe returns
 * the geographic locality directly; the denormalized name/coord avoid a join back to `candidate`.
 */
export interface PostalCityCandidateTable {
	/** {@link normalizeLocalityForKey} of the postal-city name — the build/query-consistent probe key. */
	name_key: string
	/** The postcode the alias is scoped to (the second half of the exact key). */
	postcode: string
	/** WOF id of the geographic locality the postcode sits in (the resolve target). */
	spr_id: number
	/** The geographic locality's display name. */
	name: string
	latitude: number
	longitude: number
}

/**
 * The postal-city-candidate database schema for `new
 * DatabaseClient<PostalCityCandidateDatabase>(...)`.
 */
export interface PostalCityCandidateDatabase {
	postal_city_candidate: PostalCityCandidateTable
}

/**
 * The table name the lookup probes (existence-gated, so an old candidate.db without it is
 * byte-stable).
 */
export const POSTAL_CITY_CANDIDATE_TABLE = "postal_city_candidate"

/** Column order for the builder's positional INSERT. */
export const POSTAL_CITY_CANDIDATE_COLUMNS = [
	"name_key",
	"postcode",
	"spr_id",
	"name",
	"latitude",
	"longitude",
] as const

/**
 * Create the side-index — a clustered `WITHOUT ROWID` B-tree on `(name_key, postcode)` so the
 * resolve is a single exact probe. Idempotent (`IF NOT EXISTS`); pass a {@link DatabaseClient} (or
 * any `Kysely`) over the candidate DB. The Kysely schema-builder is the house idiom for table
 * creation — see `AGENTS.md` (inline-SQL → Kysely).
 */
export async function createPostalCityCandidateTable(db: Kysely<PostalCityCandidateDatabase>): Promise<void> {
	await db.schema
		.createTable(POSTAL_CITY_CANDIDATE_TABLE)
		.ifNotExists()
		.addColumn("name_key", "text", (c) => c.notNull())
		.addColumn("postcode", "text", (c) => c.notNull())
		.addColumn("spr_id", "integer", (c) => c.notNull())
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("latitude", "real", (c) => c.notNull())
		.addColumn("longitude", "real", (c) => c.notNull())
		.addPrimaryKeyConstraint("postal_city_candidate_pk", ["name_key", "postcode"])
		// `WITHOUT ROWID` has no first-class builder; the raw modifier is the idiomatic escape hatch.
		.modifyEnd(sql`without rowid`)
		.execute()
}
