/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema for the POSTAL-CITY ALIAS table (`postal-city-alias-<cc>.db`, built by
 *   `scripts/build-postal-city-alias.ts`) — the single source of truth for the columns shared by
 *   the BUILDER and the READER ({@link WOFPostalCityAliasLookup}). Like {@link CandidateTable}, the
 *   contract is a Kysely `Database` interface plus the table DDL as a string, so a column rename in
 *   the builder is a compile error in the reader.
 *
 *   Provenance discipline (provenance-first): this is a SIBLING table to the PIP-derived
 *   `postcode_locality` data, never mixed into it — one table, one provenance class. Each row is an
 *   OBSERVED `(postcode, postal_city, geo_locality)` aggregate from Overture's `postal_city` field
 *   with a usage count `n`; `divergent = 1` exactly when `postal_city != geo_locality` (the alias
 *   signal — the only rows the resolver consumes).
 */

import type { Kysely } from "kysely"

/**
 * One observed postal-city aggregate. The natural key is `(postcode, postal_city, geo_locality)`; the builder enforces
 * a `MIN_COUNT` floor on `n`, so every row is a non-trivial usage.
 */
export interface PostalCityAliasTable {
	/** The postcode the aggregate is scoped to (the resolver probes by this). */
	postcode: string
	/** What the postal system calls the place (the surface a user is likely to type). */
	postal_city: string
	/** The geographic locality name the postcode actually sits in (≈ the gazetteer's canonical name). */
	geo_locality: string
	/** Observed row count — the evidence weight behind this alias. */
	n: number
	/** 1 when `postal_city != geo_locality` (the alias signal); 0 when they agree. */
	divergent: number
	/** Provenance: the dataset this aggregate came from (e.g. `overture:US`). */
	source: string
	/** The pinned data release the aggregate was computed from. */
	release: string
}

/** The postal-city-alias database schema for `new DatabaseClient<PostalCityAliasDatabase>(...)`. */
export interface PostalCityAliasDatabase {
	postal_city_alias: PostalCityAliasTable
}

/** The `postal_city_alias` column order — the builder's INSERT derives its column list from this. */
export const POSTAL_CITY_ALIAS_COLUMNS = [
	"postcode",
	"postal_city",
	"geo_locality",
	"n",
	"divergent",
	"source",
	"release",
] as const

/**
 * Create the `postal_city_alias` table + its two probe indexes. Kept here (not only in the builder) so tests can stand
 * up a fixture DB with the exact production shape. Pass a {@link DatabaseClient} (or any `Kysely`) over the alias DB.
 */
export async function createPostalCityAliasTable(db: Kysely<PostalCityAliasDatabase>): Promise<void> {
	await db.schema
		.createTable("postal_city_alias")
		.addColumn("postcode", "text", (c) => c.notNull())
		.addColumn("postal_city", "text", (c) => c.notNull())
		.addColumn("geo_locality", "text", (c) => c.notNull())
		.addColumn("n", "integer", (c) => c.notNull())
		.addColumn("divergent", "integer", (c) => c.notNull())
		.addColumn("source", "text", (c) => c.notNull())
		.addColumn("release", "text", (c) => c.notNull())
		.execute()
	await db.schema.createIndex("idx_pca_postcode").on("postal_city_alias").column("postcode").execute()
	await db.schema.createIndex("idx_pca_pair").on("postal_city_alias").columns(["postal_city", "geo_locality"]).execute()
}
