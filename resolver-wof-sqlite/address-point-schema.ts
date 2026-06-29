/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema for the SITUS / rooftop ADDRESS-POINT shards (`address-points-<cc>-<slug>.db`, built
 *   by `scripts/build-address-point-shard.ts` — the #476/#567 national rooftop tier behind the
 *   demo's "type any US address, get the building"). Single source of truth for the columns shared
 *   by the BUILDER and the READER ({@link AddressPointSqliteLookup}), so a column rename in one is a
 *   compile error in the other.
 *
 *   The builder's hot INSERT (tens of millions of rows per state) stays a POSITIONAL prepared
 *   statement for throughput — but its column list is derived from {@link ADDRESS_POINT_COLUMNS}
 *   here, and its table comes from {@link createAddressPointTable}, so the positional order can't
 *   silently drift from what the reader expects. (Same convention as the candidate build: typed
 *   schema guards the contract; positional inserts keep the speed.)
 */

import type { Kysely } from "kysely"

/**
 * One rooftop address point. `(street_norm, number)` within a `postcode` (preferred) or `locality_norm` scope is the
 * lookup; `street_key` is the #483 route-fold key for interpolation. Coordinates are non-null (the builder drops
 * non-finite coords). `unit`/`postcode`/`locality_norm` are nullable (not every source carries all three).
 */
export interface AddressPointTable {
	/** Shared {@link normalizeStreetForKey} of the street — the build/query-consistent probe key. */
	street_norm: string
	/** `canonicalizeRouteKey(street_norm)` — the route-fold key (#483 Method 2). */
	street_key: string
	/** House number, normalized lower-case (kept TEXT — "123-A", "12 1/2" must survive). */
	number: string
	unit: string | null
	postcode: string | null
	/** Shared {@link normalizeLocalityForKey} of the locality — the fallback scope. */
	locality_norm: string | null
	/** The street as it appeared in the source (kept for display / debugging). */
	street_raw: string
	lat: number
	lon: number
	/** Provenance: the dataset this point came from (e.g. `overture:us`, `openaddresses`). */
	source: string
	/** The pinned data release the point was ingested from. */
	release: string
}

/** The address-point database schema for `new DatabaseClient<AddressPointDatabase>(...)`. */
export interface AddressPointDatabase {
	address_point: AddressPointTable
}

/**
 * The `address_point` columns in INSERT order. The builder's positional prepared statement derives its placeholder list
 * from this, so the positional order can't drift from the DDL / the reader.
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
] as const

/** Create the `address_point` table — called before the streaming bulk load. */
export async function createAddressPointTable(db: Kysely<AddressPointDatabase>): Promise<void> {
	await db.schema
		.createTable("address_point")
		.addColumn("street_norm", "text", (c) => c.notNull())
		// `street_key` = canonicalizeRouteKey(street_norm): the route-fold key (#483 Method 2).
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
		.execute()
}

/** Create the three probe indexes the reader relies on (postcode-scope, locality-scope, route-key). */
export async function createAddressPointIndexes(db: Kysely<AddressPointDatabase>): Promise<void> {
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
	// Street-first index for the BBOX scope (#247): OSM points often carry no postcode/locality, so the
	// reader scopes a `(street_norm, number)` probe by the resolved locality's bbox (lat/lon BETWEEN). The
	// postcode/locality indexes lead with their scope column and can't serve this; US situs never probes by
	// bbox so it simply carries one extra (cheap) index on a future rebuild.
	await db.schema.createIndex("idx_ap_street").on("address_point").columns(["street_norm", "number"]).execute()
}
