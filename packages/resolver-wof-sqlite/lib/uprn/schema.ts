/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Typed schema for `uprn.db`, storing OS's own WGS84 latitude/longitude verbatim rather than reconverting from the source's eastings.
 */

import type { layerschemadatabase } from "@mailwoman/core/layers"
import { shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import { latLngToCell } from "h3-js"
import type { Kysely } from "kysely"

/**
 * Resolution the `uprn` table's `h3_cell` column is keyed at, shared with the other layer spines.
 */
export const UPRN_H3_RESOLUTION = 9

/**
 * Resolution of the layer's `layer_coverage` cells, coarse per the layer interface
 * and shared with the other spines.
 */
export const UPRN_COVERAGE_H3_RESOLUTION = 6

/**
 * One uprn point whose `uprn` is a rowid alias, making the primary probe a rowid B-tree hit.
 */
export interface UPRNTable {
	/**
	 * The Unique Property Reference Number — up to 12 digits, so always within `Number.MAX_SAFE_INTEGER`.
	 */
	uprn: number
	/**
	 * WGS84 latitude, as OS published it, never reconverted from eastings.
	 */
	lat: number
	/**
	 * WGS84 longitude, as OS published it.
	 */
	lon: number
	/**
	 * 48-bit short H3 cell at {@link UPRN_H3_RESOLUTION} — the layer-interface spine key
	 * and the `nearestUPRN` probe index.
	 */
	h3_cell: number
}

/**
 * Build-provenance key/value pairs the fixed `layer_manifest` columns have no room for,
 * including the upstream licence text verbatim.
 */
export interface UPRNMetaTable {
	key: string
	value: string
}

export interface UPRNDatabase extends layerschemadatabase {
	uprn: UPRNTable
	uprn_meta: UPRNMetaTable
}

/**
 * The full res-9 cell for a UPRN point.
 *
 * This is the one derivation the builder and its consumers share so their cells cannot disagree.
 */
export function uprnFullCell(latitude: number, longitude: number): H3Cell {
	return latLngToCell(latitude, longitude, UPRN_H3_RESOLUTION) as H3Cell
}

/**
 * The `h3_cell` column value for a uprn point, packing {@link uprnFullCell} to
 * the shared 48-bit short-cell integer.
 */
export function uprnH3Cell(latitude: number, longitude: number): number {
	return shortCellToInt(uprnFullCell(latitude, longitude))
}

export async function createUPRNTable(db: Kysely<UPRNDatabase>): Promise<void> {
	await db.schema
		.createTable("uprn")
		.addColumn("uprn", "integer", (c) => c.primaryKey())
		.addColumn("lat", "real", (c) => c.notNull())
		.addColumn("lon", "real", (c) => c.notNull())
		.addColumn("h3_cell", "integer", (c) => c.notNull())
		.execute()
}

export async function createUPRNMetaTable(db: Kysely<UPRNDatabase>): Promise<void> {
	await db.schema
		.createTable("uprn_meta")
		.addColumn("key", "text", (c) => c.primaryKey())
		.addColumn("value", "text", (c) => c.notNull())
		.execute()
}

/**
 * Secondary index for the `nearestUPRN` ring probe, created after the bulk load.
 */
export async function createUPRNIndexes(db: Kysely<UPRNDatabase>): Promise<void> {
	await db.schema.createIndex("uprn_h3_cell").on("uprn").column("h3_cell").execute()
}
