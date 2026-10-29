/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The shared rooftop schema with an H3 spine column and the layer-interface tables.
 *
 *   The OpenStreetMap and G-NAF rooftop builders write this shape. Readers of existing address points
 *   project only the columns of `address_point` in `#address/point/schema`, so the H3 spine and the
 *   layer-interface tables leave their query path unchanged.
 */

import { createLayerCoverageTable, createLayerManifestTable, type layerschemadatabase } from "@mailwoman/core/layers"
import type { Kysely } from "kysely"

import { ADDRESS_POINT_COLUMNS, type AddressPointTable, createAddressPointTable } from "#address/point/schema"

/**
 * Jitter-stable address/POI join cell.
 * Matches @mailwoman/address-id.
 */
export const ADDRESS_POINT_H3_RESOLUTION = 9

export interface SpineAddressPointTable extends AddressPointTable {
	/**
	 * 48-bit shortened H3 cell stored as a safe SQLite integer.
	 */
	h3_cell: number
}

export interface SpineAddressPointDatabase extends layerschemadatabase {
	address_point: SpineAddressPointTable
}

/**
 * Positional insert order: the shared address-point fields followed by the H3 spine.
 */
export const SPINE_ADDRESS_POINT_COLUMNS = [...ADDRESS_POINT_COLUMNS, "h3_cell"] as const

/**
 * Create the legacy-compatible domain table plus the H3 spine and the layer-interface tables.
 */
export async function createSpineAddressPointTables(db: Kysely<SpineAddressPointDatabase>): Promise<void> {
	await createAddressPointTable(db)

	await db.schema
		.alterTable("address_point")
		.addColumn("h3_cell", "integer", (column) => column.notNull())
		.execute()

	await createLayerManifestTable(db)
	await createLayerCoverageTable(db)
}

/**
 * Build after the bulk load so the spine index is not updated on every streaming insert.
 */
export async function createSpineAddressPointIndexes(db: Kysely<SpineAddressPointDatabase>): Promise<void> {
	await db.schema.createIndex("idx_ap_h3").on("address_point").column("h3_cell").execute()
}
