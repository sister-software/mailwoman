/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Kysely } from "kysely"

import type { NameKey, RouteKey, StreetKey } from "#street/normalize"

/**
 * One rooftop address point; `(street_norm, number)` within a `postcode` or `locality_norm` scope is the lookup.
 */
export interface AddressPointTable {
	/**
	 * Shared {@link normalizeStreetForKey} of the street — the build/query-consistent probe key.
	 */
	street_norm: StreetKey
	/**
	 * `canonicalizeRouteKey(street_norm)` — the route-fold key, branded so it cannot be interchanged with `street_norm`.
	 */
	street_key: RouteKey
	/**
	 * House number, normalized lower-case (kept text — "123-A", "12 1/2" must survive).
	 */
	number: string
	unit: string | null
	postcode: string | null
	/**
	 * Shared {@link normalizeLocalityForKey} of the locality — the fallback scope.
	 */
	locality_norm: NameKey | null

	street_raw: string
	lat: number
	lon: number
	/**
	 * Provenance: the dataset this point came from (e.g. `overture:us`, `openaddresses`).
	 */
	source: string

	release: string
	/**
	 * The source register's stable administrative key for the point's commune or municipality — BAN's `code_insee`; the coverage basis is computed per this key.
	 */
	admin_code: string | null
	/**
	 * The register's own certification flag for the point (BAN `certification_commune`: 1 certified, 0 not), never inferred from a share.
	 */
	certified: number | null
}

/**
 * The address-point database schema for `new DatabaseClient<AddressPointDatabase>(...)`.
 */
export interface AddressPointDatabase {
	address_point: AddressPointTable
}

/**
 * The subset of a Kysely handle the DDL touches, narrowed to `schema` because Kysely is invariant in its schema parameter.
 */
export type AddressPointSchemaHandle = Pick<Kysely<AddressPointDatabase>, "schema">

/**
 * The `address_point` columns in insert order, from which the builder derives its positional placeholders.
 */
export const ADDRESS_POINT_COLUMNS = [
	"street_norm",
	"street_key",
	"number",
	"unit",
	"postcode",
	"locality_norm",
	"street_raw",
	"lat",
	"lon",
	"source",
	"release",
	"admin_code",
	"certified",
] as const

/**
 * Create the `address_point` table — called before the streaming bulk load.
 */
export async function createAddressPointTable(db: AddressPointSchemaHandle): Promise<void> {
	await db.schema
		.createTable("address_point")
		.addColumn("street_norm", "text", (c) => c.notNull())

		.addColumn("street_key", "text", (c) => c.notNull())
		.addColumn("number", "text", (c) => c.notNull())
		.addColumn("unit", "text")
		.addColumn("postcode", "text")
		.addColumn("locality_norm", "text")
		.addColumn("street_raw", "text", (c) => c.notNull())
		.addColumn("lat", "real", (c) => c.notNull())
		.addColumn("lon", "real", (c) => c.notNull())
		.addColumn("source", "text", (c) => c.notNull())
		.addColumn("release", "text", (c) => c.notNull())
		.addColumn("admin_code", "text")
		.addColumn("certified", "integer")
		.execute()
}

/**
 * Create the three probe indexes the reader relies on (postcode-scope, locality-scope, route-key).
 */
export async function createAddressPointIndexes(db: AddressPointSchemaHandle): Promise<void> {
	await db.schema
		.createIndex("idx_ap_postcode")
		.on("address_point")
		.columns(["postcode", "street_norm", "number"])
		.execute()

	await db.schema
		.createIndex("idx_ap_locality")
		.on("address_point")
		.columns(["locality_norm", "street_norm", "number"])
		.execute()

	await db.schema.createIndex("idx_ap_streetkey").on("address_point").columns(["postcode", "street_key"]).execute()
	// Street-first index for the bbox scope: OSM points often carry no postcode or locality, so the reader scopes a `(street_norm, number)` probe by the resolved locality's bbox.
	await db.schema.createIndex("idx_ap_street").on("address_point").columns(["street_norm", "number"]).execute()
}
