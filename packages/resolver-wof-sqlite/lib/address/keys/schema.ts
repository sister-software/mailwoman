/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The address layer's two files. `lookup.db` holds one clustered key table per level of precision a parse can
 *   reach, each row holding its answer, plus street aggregates and the `source` table. `detail.db` holds the full
 *   `address` record. A reader opens it only to show one result in detail.
 *
 *   Every key table is `WITHOUT ROWID` and clustered on its key, so a lookup is one B-tree descent over contiguous
 *   pages, the property a reader of the file by HTTP range depends on.
 */

import { type Kysely, sql } from "kysely"

/**
 * One source of address points: its wire id, publisher and terms.
 */
export interface AddressSourceTable {
	source_id: number
	/**
	 * The wire source id the adapter writes, such as `usgov-nad` or `openaddresses:us/wi/statewide`.
	 */
	name: string
	/**
	 * The license expression its rows are published under, such as `CC-BY-4.0`,
	 * or `null` when its terms are unread.
	 */
	license: string | null
	/**
	 * The publisher or assigning authority, such as `co.adams.wi.us`, or `null` when unstated.
	 */
	authority: string | null
	/**
	 * The address points the file holds from this source.
	 */
	records: number
}

/**
 * One key row: the street and number under one scope, with the point that answers it.
 *
 * `scope` is the level's own value: a postcode, a locality form's key, or a county's key.
 */
export interface AddressKeyTable {
	scope: string
	street: string
	number: string
	address_id: number
	lat: number
	lon: number
	source_id: number
}

/**
 * A key row under a Who's On First place id, for a locality the gazetteer resolved.
 */
export interface AddressPlaceKeyTable extends Omit<AddressKeyTable, "scope"> {
	wof_id: number
}

/**
 * A key row for the file's whole region, keyed by street and number without a scope.
 */
export type AddressRegionKeyTable = Omit<AddressKeyTable, "scope">

/**
 * One street under one scope, for a parse with no house number or a number the source lacks.
 */
export interface AddressStreetTable {
	scope: string
	street: string
	lat: number
	lon: number
	min_lat: number
	max_lat: number
	min_lon: number
	max_lon: number
	points: number
}

/**
 * The `lookup.db` schema, for `new DatabaseClient<AddressLookupDatabase>(...)`.
 */
export interface AddressLookupDatabase {
	source: AddressSourceTable
	key_postcode: AddressKeyTable
	key_locality: AddressKeyTable
	key_subregion: AddressKeyTable
	key_place: AddressPlaceKeyTable
	key_region: AddressRegionKeyTable
	street_postcode: AddressStreetTable
	street_locality: AddressStreetTable
}

/**
 * The key tables scoped by a text value, in the order a reader falls back through them.
 */
export const ADDRESS_SCOPED_KEY_TABLES = ["key_postcode", "key_locality", "key_subregion"] as const

export type AddressScopedKeyTableName = (typeof ADDRESS_SCOPED_KEY_TABLES)[number]

/**
 * The street aggregate tables, one per scoped level a parse without a number can state.
 */
export const ADDRESS_STREET_TABLES = ["street_postcode", "street_locality"] as const

export type AddressStreetTableName = (typeof ADDRESS_STREET_TABLES)[number]

/**
 * One address point's full record, kept apart from the lookup file.
 */
export interface AddressDetailTable {
	address_id: number
	source_id: number
	/**
	 * The publisher's own id for the point.
	 */
	source_record_id: string
	country: string
	number: string
	unit: string | null
	street_raw: string
	postcode: string | null
	/**
	 * Every name the record states, as JSON: `[{"level", "form", "value"}]`.
	 */
	names: string
	admin_code: string | null
	lat: number
	lon: number
	placement: string | null
	authority: string | null
}

/**
 * The `detail.db` schema, for `new DatabaseClient<AddressDetailDatabase>(...)`.
 */
export interface AddressDetailDatabase {
	address: AddressDetailTable
}

/**
 * Creates the `source` table.
 */
export async function createAddressSourceTable(db: Kysely<AddressLookupDatabase>): Promise<void> {
	await db.schema
		.createTable("source")
		.addColumn("source_id", "integer", (c) => c.primaryKey())
		.addColumn("name", "text", (c) => c.notNull().unique())
		.addColumn("license", "text")
		.addColumn("authority", "text")
		.addColumn("records", "integer", (c) => c.notNull())
		.execute()
}

/**
 * Creates one scoped key table, clustered on `(scope, street, number, address_id)`.
 */
export async function createAddressScopedKeyTable(
	db: Kysely<AddressLookupDatabase>,
	table: AddressScopedKeyTableName
): Promise<void> {
	await db.schema
		.createTable(table)
		.addColumn("scope", "text", (c) => c.notNull())
		.addColumn("street", "text", (c) => c.notNull())
		.addColumn("number", "text", (c) => c.notNull())
		.addColumn("address_id", "integer", (c) => c.notNull())
		.addColumn("lat", "real", (c) => c.notNull())
		.addColumn("lon", "real", (c) => c.notNull())
		.addColumn("source_id", "integer", (c) => c.notNull())
		.addPrimaryKeyConstraint(`${table}_pk`, ["scope", "street", "number", "address_id"])
		// `without rowid` has no first-class builder. The raw modifier is the idiomatic fallback.
		.modifyEnd(sql`without rowid`)
		.execute()
}

/**
 * Creates the place key table, clustered on `(wof_id, street, number, address_id)`.
 */
export async function createAddressPlaceKeyTable(db: Kysely<AddressLookupDatabase>): Promise<void> {
	await db.schema
		.createTable("key_place")
		.addColumn("wof_id", "integer", (c) => c.notNull())
		.addColumn("street", "text", (c) => c.notNull())
		.addColumn("number", "text", (c) => c.notNull())
		.addColumn("address_id", "integer", (c) => c.notNull())
		.addColumn("lat", "real", (c) => c.notNull())
		.addColumn("lon", "real", (c) => c.notNull())
		.addColumn("source_id", "integer", (c) => c.notNull())
		.addPrimaryKeyConstraint("key_place_pk", ["wof_id", "street", "number", "address_id"])
		.modifyEnd(sql`without rowid`)
		.execute()
}

/**
 * Creates the region key table, clustered on `(street, number, address_id)`.
 */
export async function createAddressRegionKeyTable(db: Kysely<AddressLookupDatabase>): Promise<void> {
	await db.schema
		.createTable("key_region")
		.addColumn("street", "text", (c) => c.notNull())
		.addColumn("number", "text", (c) => c.notNull())
		.addColumn("address_id", "integer", (c) => c.notNull())
		.addColumn("lat", "real", (c) => c.notNull())
		.addColumn("lon", "real", (c) => c.notNull())
		.addColumn("source_id", "integer", (c) => c.notNull())
		.addPrimaryKeyConstraint("key_region_pk", ["street", "number", "address_id"])
		.modifyEnd(sql`without rowid`)
		.execute()
}

/**
 * Creates one street aggregate table, clustered on `(scope, street)`.
 */
export async function createAddressStreetTable(
	db: Kysely<AddressLookupDatabase>,
	table: AddressStreetTableName
): Promise<void> {
	await db.schema
		.createTable(table)
		.addColumn("scope", "text", (c) => c.notNull())
		.addColumn("street", "text", (c) => c.notNull())
		.addColumn("lat", "real", (c) => c.notNull())
		.addColumn("lon", "real", (c) => c.notNull())
		.addColumn("min_lat", "real", (c) => c.notNull())
		.addColumn("max_lat", "real", (c) => c.notNull())
		.addColumn("min_lon", "real", (c) => c.notNull())
		.addColumn("max_lon", "real", (c) => c.notNull())
		.addColumn("points", "integer", (c) => c.notNull())
		.addPrimaryKeyConstraint(`${table}_pk`, ["scope", "street"])
		.modifyEnd(sql`without rowid`)
		.execute()
}

/**
 * Creates the `address` detail table, keyed by `address_id`.
 *
 * The rows store their names as JSON and are read one at a time by id, so the table keeps its rowid.
 */
export async function createAddressDetailTable(db: Kysely<AddressDetailDatabase>): Promise<void> {
	await db.schema
		.createTable("address")
		.addColumn("address_id", "integer", (c) => c.primaryKey())
		.addColumn("source_id", "integer", (c) => c.notNull())
		.addColumn("source_record_id", "text", (c) => c.notNull())
		.addColumn("country", "text", (c) => c.notNull())
		.addColumn("number", "text", (c) => c.notNull())
		.addColumn("unit", "text")
		.addColumn("street_raw", "text", (c) => c.notNull())
		.addColumn("postcode", "text")
		.addColumn("names", "text", (c) => c.notNull())
		.addColumn("admin_code", "text")
		.addColumn("lat", "real", (c) => c.notNull())
		.addColumn("lon", "real", (c) => c.notNull())
		.addColumn("placement", "text")
		.addColumn("authority", "text")
		.execute()
}
