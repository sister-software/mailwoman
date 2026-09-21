/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema for the postal-city candidate side-index (#741 / #475) — a small `(name_key,
 *   postcode) → geo-locality` table that lives alongside the byte-range `candidate` table so the
 *   candidate-backend resolver (the demo/CLI default) can do what the FTS coordinate-first scorer
 *   does: resolve a user-typed postal city ("Antioch", 37013) to the geographic locality the
 *   postcode sits in ("Nashville").
 *
 *   Why a side-index rather than cloned `candidate` rows: the `candidate` B-tree is keyed `(name_key,
 *   country_id, region_id, placetype_id, …)` and ranked population-first — it has no postcode
 *   dimension. A cloned alias row was tested (#741) and falsified: a sentinel rank is
 *   bare-name-safe but then loses to any in-region homonym, and there is no single rank that is
 *   both. The fix is an exact `(name_key, postcode)` probe that bypasses population/region ranking
 *   entirely — consulted only when the query carries a postcode, so the common no-postcode path is
 *   untouched.
 */

import { sql, type Kysely } from "kysely"

import type { NameKey } from "#street/normalize"

/**
 * One postal-city → geo-locality edge, keyed exactly by `(name_key, postcode)`.
 *
 * The probe returns the geographic locality directly. the denormalized name/coord
 * avoid a join back to `candidate`.
 */
export interface PostalCityCandidateTable {
	/**
	 * {@link normalizeLocalityForKey} of the postal-city name — the build/query-consistent probe key.
	 */
	name_key: NameKey
	/**
	 * The postcode the alias is scoped to (the second half of the exact key).
	 */
	postcode: string
	/**
	 * WOF id of the geographic locality the postcode sits in (the resolve target).
	 */
	spr_id: number
	/**
	 * The geographic locality's display name.
	 */
	name: string
	latitude: number
	longitude: number
}

/**
 * The postal-city-candidate database schema for `new DatabaseClient<PostalCityCandidateDatabase>(...)`.
 */
export interface PostalCityCandidateDatabase {
	postal_city_candidate: PostalCityCandidateTable
}

/**
 * The table name the lookup probes (existence-restricted, so an old candidate.db without it is byte-stable).
 */
export const POSTAL_CITY_CANDIDATE_TABLE = "postal_city_candidate"

/**
 * Column order for the builder's positional insert.
 */
export const POSTAL_CITY_CANDIDATE_COLUMNS = [
	"name_key",
	"postcode",
	"spr_id",
	"name",
	"latitude",
	"longitude",
] as const

/**
 * Create the side-index — a clustered `without rowid` B-tree on `(name_key, postcode)`
 * so the resolve is a single exact probe.
 *
 * Idempotent (`if not exists`); pass a {@link DatabaseClient} (or any `Kysely`) over the candidate DB.
 * The Kysely schema-builder is the house idiom for table creation — see `agents.md` (inline-SQL → Kysely).
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
		// `without rowid` has no first-class builder. the raw modifier is the idiomatic fallback.
		.modifyEnd(sql`without rowid`)
		.execute()
}
