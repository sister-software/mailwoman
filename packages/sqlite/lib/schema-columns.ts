/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { CreateTableBuilder, Kysely } from "kysely"

/**
 * The subset of a Kysely handle a schema module's DDL touches.
 *
 * Kysely is invariant in its schema parameter, so naming only this member lets a caller pass its own wider handle.
 */
export type SchemaHandle<DB> = Pick<Kysely<DB>, "schema">

/**
 * The precomputed bounding box every polygon table carries — truth tables
 * and extent tables alike — in the order the sealed artifacts store it.
 */
export function addBoundingBoxColumns<TB extends string, C extends string>(
	builder: CreateTableBuilder<TB, C>
): CreateTableBuilder<TB, C | "min_lat" | "min_lon" | "max_lat" | "max_lon"> {
	return builder
		.addColumn("min_lat", "real", (column) => column.notNull())
		.addColumn("min_lon", "real", (column) => column.notNull())
		.addColumn("max_lat", "real", (column) => column.notNull())
		.addColumn("max_lon", "real", (column) => column.notNull())
}

/**
 * The unsimplified ring blob a polygon truth table carries, separate from {@link addBoundingBoxColumns}
 * because one layer's stored column order between the box and the blob is part of what sealed-artifact readers see.
 *
 * A table taking this stays a plain rowid table, never `without rowid`: the `rings` blob is exactly
 * the payload clustering into the B-tree penalizes.
 */
export function addRingsColumn<TB extends string, C extends string>(
	builder: CreateTableBuilder<TB, C>
): CreateTableBuilder<TB, C | "rings"> {
	return builder.addColumn("rings", "blob", (column) => column.notNull())
}

/**
 * The precomputed bounding box plus the unsimplified ring blob every polygon truth table carries:
 * {@link addBoundingBoxColumns} then {@link addRingsColumn}, with no columns between them.
 */
export function addRingGeometryColumns<TB extends string, C extends string>(
	builder: CreateTableBuilder<TB, C>
): CreateTableBuilder<TB, C | "min_lat" | "min_lon" | "max_lat" | "max_lon" | "rings"> {
	return addRingsColumn(addBoundingBoxColumns(builder))
}

/**
 * The cell-index columns every polygon summary tier carries: the 48-bit short cell, the resolution it was
 * captured at, the key columns the row names, and its containment.
 *
 * Small fixed-width rows probed by their exact primary key are the `without rowid` shape; the caller adds
 * its own primary-key constraint and the raw `without rowid` modifier because the key differs per layer.
 */
export function addCellIndexColumns<TB extends string, C extends string, K extends string>(
	builder: CreateTableBuilder<TB, C>,
	keyColumns: K | readonly K[]
): CreateTableBuilder<TB, C | K | "h3_cell" | "resolution" | "containment"> {
	let keyed: CreateTableBuilder<TB, C | K | "h3_cell" | "resolution"> = builder
		.addColumn("h3_cell", "integer", (column) => column.notNull())
		.addColumn("resolution", "integer", (column) => column.notNull())

	for (const keyColumn of typeof keyColumns === "string" ? [keyColumns] : keyColumns) {
		keyed = keyed.addColumn(keyColumn, "text", (column) => column.notNull())
	}

	return keyed.addColumn("containment", "text", (column) => column.notNull())
}
