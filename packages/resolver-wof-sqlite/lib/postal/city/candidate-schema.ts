/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema for the postal-city candidate side-index, a small `(name_key, postcode)` →
 *   geo-locality table alongside the byte-range `candidate` table. The candidate-backend resolver
 *   (the demo and CLI default) can then do what the FTS coordinate-first scorer does, which is
 *   resolve a user-typed postal city ("Antioch", 37013) to the geographic locality the postcode
 *   sits in ("Nashville").
 *
 *   The `candidate` B-tree is keyed `(name_key, country_id, region_id, placetype_id, …)` and ranked
 *   population-first, so it has no postcode dimension. A cloned alias row cannot satisfy both
 *   purposes, because a sentinel rank is bare-name-safe and then loses to any in-region homonym.
 *   The exact `(name_key, postcode)` probe bypasses population and region ranking entirely, and it
 *   is consulted only when the query carries a postcode, so the common no-postcode path is
 *   untouched.
 */

import { sql, type Kysely } from "kysely"

import type { NameKey } from "#street/normalize"

/**
 * One postal-city → geo-locality edge, keyed exactly by `(name_key, postcode)`.
 *
 * The probe returns the geographic locality directly.
 * The denormalized name/coord avoid a join back to `candidate`.
 */
export interface PostalCityCandidateTable {
	/**
	 * {@link normalizeLocalityForKey} of the postal-city name, the build/query-consistent probe key.
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
 * Create the side-index, a clustered `without rowid` B-tree on `(name_key, postcode)`
 * so the resolve is a single exact probe.
 *
 * Idempotent (`if not exists`).
 * Pass a {@link DatabaseClient} (or any `Kysely`) over the candidate DB.
 *
 * The Kysely schema-builder is the house idiom for table creation.
 * See `agents.md` on inline SQL and Kysely.
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
		// `without rowid` has no first-class builder. The raw modifier is the idiomatic fallback.
		.modifyEnd(sql`without rowid`)
		.execute()
}
