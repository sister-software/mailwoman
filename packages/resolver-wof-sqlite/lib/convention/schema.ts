/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema for the convention asset — the `address_convention` table `SqliteConventionSource` probes, plus the
 *   `meta` provenance row every sealed artifact here carries. The interface is the read/write contract and
 *   {@link createAddressConventionTable} creates the table, so a column added to one is a compile error against the
 *   other.
 */

import type { Kysely } from "kysely"

import { ADDRESS_CONVENTION_TABLE } from "#convention/index"

/**
 * One convention profile, keyed by the WOF admin polygon it attaches to.
 */
export interface AddressConventionTable {
	wof_id: number
	/**
	 * The `Convention` record, JSON-encoded. Parsed at read time by `SqliteConventionSource`.
	 */
	convention: string
	/**
	 * Provenance: why this row exists and where it came from.
	 */
	source: string
}

/**
 * Key/value provenance for the sealed artifact.
 */
export interface ConventionMetaTable {
	key: string
	value: string | null
}

export interface ConventionDatabase {
	address_convention: AddressConventionTable
	meta: ConventionMetaTable
}

/**
 * The slice of a Kysely handle the convention DDL touches. Kysely is invariant in its schema parameter, so naming only
 * `schema` lets a builder holding a wider handle pass it without a cast.
 */
export type ConventionSchemaHandle = Pick<Kysely<ConventionDatabase>, "schema">

/**
 * Create `address_convention`. The table name comes from {@link ADDRESS_CONVENTION_TABLE} so the build script, the
 * runtime source, and the extract auto-detect cannot drift apart.
 */
export async function createAddressConventionTable(db: ConventionSchemaHandle): Promise<void> {
	await db.schema
		.createTable(ADDRESS_CONVENTION_TABLE)
		.addColumn("wof_id", "integer", (column) => column.primaryKey())
		.addColumn("convention", "text", (column) => column.notNull())
		.addColumn("source", "text", (column) => column.notNull())
		.execute()
}

/**
 * Create the artifact's `meta` table.
 */
export async function createConventionMetaTable(db: ConventionSchemaHandle): Promise<void> {
	await db.schema
		.createTable("meta")
		.addColumn("key", "text", (column) => column.primaryKey())
		.addColumn("value", "text")
		.execute()
}
