// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Typed schema for the undersea layer database, with the layer-interface
 *   tables from `@mailwoman/core/layers`.
 *
 *   One row is one gazetteer record under one geometry kind.
 *   The gazetteer can publish the same `FEATURE_ID` in more than one service layer,
 *   so the key is the id and the kind together.
 *
 *   The geometry is stored verbatim as GeoJSON text, because the table holds about
 *   5,400 rows and no reader probes it by shape.
 */

import type { layerschemadatabase } from "@mailwoman/core/layers"
import type { Kysely } from "kysely"

/**
 * The H3 resolution of `h3_cell`, the label point's cell.
 *
 * Resolution 5 cells are about 250 km² across, finer than any feature's label needs.
 */
export const UNDERSEA_H3_RESOLUTION = 5

/**
 * One gazetteer record under one geometry kind.
 */
export interface UnderseaFeatureTable {
	feature_id: number
	/**
	 * `point`, `line` or `polygon`.
	 */
	kind: string
	name: string
	generic_term: string
	display_name: string
	/**
	 * The name key `underseaNameKey` computes, indexed for exact lookups.
	 */
	name_key: string
	label_lon: number
	label_lat: number
	/**
	 * The label point's H3 cell at {@link UNDERSEA_H3_RESOLUTION}, as a 48-bit short cell.
	 */
	h3_cell: number
	min_lon: number
	min_lat: number
	max_lon: number
	max_lat: number
	/**
	 * The publisher's geometry as GeoJSON text, in WGS 84.
	 */
	geometry: string
	/**
	 * The depth as a negative elevation in meters, read from the ETOPO1 grid in the terrain tiles, or null.
	 */
	depth_m: number | null
	/**
	 * `deepest` or `shallowest`: which sample `depth_m` reports.
	 * Null alongside a null depth.
	 */
	depth_kind: string | null
}

export interface UnderseaDatabase extends layerschemadatabase {
	undersea_feature: UnderseaFeatureTable
}

/**
 * Creates the domain table and its name index.
 */
export async function createUnderseaTables(db: Kysely<UnderseaDatabase>): Promise<void> {
	await db.schema
		.createTable("undersea_feature")
		.addColumn("feature_id", "integer", (column) => column.notNull())
		.addColumn("kind", "text", (column) => column.notNull())
		.addColumn("name", "text", (column) => column.notNull())
		.addColumn("generic_term", "text", (column) => column.notNull())
		.addColumn("display_name", "text", (column) => column.notNull())
		.addColumn("name_key", "text", (column) => column.notNull())
		.addColumn("label_lon", "real", (column) => column.notNull())
		.addColumn("label_lat", "real", (column) => column.notNull())
		.addColumn("h3_cell", "integer", (column) => column.notNull())
		.addColumn("min_lon", "real", (column) => column.notNull())
		.addColumn("min_lat", "real", (column) => column.notNull())
		.addColumn("max_lon", "real", (column) => column.notNull())
		.addColumn("max_lat", "real", (column) => column.notNull())
		.addColumn("geometry", "text", (column) => column.notNull())
		.addColumn("depth_m", "integer")
		.addColumn("depth_kind", "text")
		.addPrimaryKeyConstraint("undersea_feature_pk", ["feature_id", "kind"])
		.execute()

	await db.schema.createIndex("undersea_feature_name_key").on("undersea_feature").column("name_key").execute()
	await db.schema.createIndex("undersea_feature_h3_cell").on("undersea_feature").column("h3_cell").execute()
}
