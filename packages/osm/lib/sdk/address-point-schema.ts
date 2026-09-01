/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * OSM's additive extension of the shared rooftop schema. Existing address-point readers project
 * only the legacy columns, so the H3 spine and layer-contract tables do not change their query path.
 */

import { createLayerCoverageTable, createLayerManifestTable, type LayerContractDatabase } from "@mailwoman/core/layers"
import {
	ADDRESS_POINT_COLUMNS,
	type AddressPointTable,
	createAddressPointTable,
} from "@mailwoman/resolver-wof-sqlite/address-point-schema"
import type { Kysely } from "kysely"

/**
 * Jitter-stable address/POI join cell; matches @mailwoman/address-id.
 */
export const OSM_ADDRESS_H3_RESOLUTION = 9

export interface OSMAddressPointTable extends AddressPointTable {
	/**
	 * 48-bit shortened H3 cell stored as a safe SQLite integer.
	 */
	h3_cell: number
}

export interface OSMAddressPointDatabase extends LayerContractDatabase {
	address_point: OSMAddressPointTable
}

/**
 * Positional insert order: the shared address-point fields followed by OSM's H3 spine.
 */
export const OSM_ADDRESS_POINT_COLUMNS = [...ADDRESS_POINT_COLUMNS, "h3_cell"] as const

/**
 * Create the legacy-compatible domain table plus OSM's contract/spine extension.
 */
export async function createOSMAddressPointTables(db: Kysely<OSMAddressPointDatabase>): Promise<void> {
	await createAddressPointTable(db)

	await db.schema
		.alterTable("address_point")
		.addColumn("h3_cell", "integer", (column) => column.notNull())
		.execute()

	await createLayerManifestTable(db)
	await createLayerCoverageTable(db)
}

/**
 * Build after the bulk load so the spine index does not tax streaming inserts.
 */
export async function createOSMAddressPointIndexes(db: Kysely<OSMAddressPointDatabase>): Promise<void> {
	await db.schema.createIndex("idx_ap_h3").on("address_point").column("h3_cell").execute()
}
