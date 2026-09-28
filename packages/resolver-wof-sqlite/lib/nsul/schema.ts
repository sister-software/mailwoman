/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Typed schema for `nsul.db`, the GB UPRN-to-unit-postcode register.
 */

import type { layerschemadatabase } from "@mailwoman/core/layers"
import { sql, type Kysely } from "kysely"

/**
 * Resolution of the `h3_cell` column, matching the res-9 spine `uprn.db` keys on
 * because the value is copied from it.
 */
export const NSUL_H3_RESOLUTION = 9

/**
 * Resolution of the layer's `layer_coverage` cells, matching `uprn.db`'s
 * so both coverage tables describe the same cells.
 */
export const NSUL_COVERAGE_H3_RESOLUTION = 6

/**
 * One UPRN with its unit postcode and the point OS publishes for it.
 */
export interface UPRNPostcodeTable {
	/**
	 * The Unique Property Reference Number, up to 12 digits, so always within `Number.MAX_SAFE_INTEGER`.
	 */
	uprn: number
	/**
	 * The unit postcode as nsul writes it: outward code, one space, inward code (`RG40 4HR`).
	 */
	pcds: string
	/**
	 * {@link pcds} with the space removed (`RG404HR`), the form Code-Point Open's
	 * `spr.name` carries and `uprnsForPostcode` probes.
	 */
	pcds_compact: string
	/**
	 * WGS84 latitude, copied from `uprn.db` for the same UPRN.
	 */
	lat: number
	/**
	 * WGS84 longitude, copied from `uprn.db` for the same UPRN.
	 */
	lon: number
	/**
	 * 48-bit short H3 cell at {@link NSUL_H3_RESOLUTION}, copied from `uprn.db` for the same UPRN.
	 */
	h3_cell: number
}

/**
 * Build-provenance key/value pairs the fixed `layer_manifest` columns have no room for.
 */
export interface NSULMetaTable {
	key: string
	value: string
}

export interface NSULDatabase extends layerschemadatabase {
	uprn_postcode: UPRNPostcodeTable
	nsul_meta: NSULMetaTable
}

/**
 * The compact form of a unit postcode, every space removed and upper-cased.
 */
export function compactPostcode(pcds: string): string {
	return pcds.replaceAll(/\s+/g, "").toUpperCase()
}

export async function createUPRNPostcodeTable(db: Kysely<NSULDatabase>): Promise<void> {
	await db.schema
		.createTable("uprn_postcode")
		.addColumn("uprn", "integer", (c) => c.primaryKey())
		.addColumn("pcds", "text", (c) => c.notNull())
		.addColumn("pcds_compact", "text", (c) => c.notNull())
		.addColumn("lat", "real", (c) => c.notNull())
		.addColumn("lon", "real", (c) => c.notNull())
		.addColumn("h3_cell", "integer", (c) => c.notNull())
		.modifyEnd(sql`without rowid`)
		.execute()
}

export async function createNSULMetaTable(db: Kysely<NSULDatabase>): Promise<void> {
	await db.schema
		.createTable("nsul_meta")
		.addColumn("key", "text", (c) => c.primaryKey())
		.addColumn("value", "text", (c) => c.notNull())
		.execute()
}

/**
 * The `pcds_compact` index the `uprnsForPostcode` probe reads; there is no index on the
 * spaced `pcds` because it is derivable through {@link compactPostcode}.
 */
export async function createNSULIndexes(db: Kysely<NSULDatabase>): Promise<void> {
	await db.schema.createIndex("uprn_postcode_pcds_compact").on("uprn_postcode").column("pcds_compact").execute()
}
