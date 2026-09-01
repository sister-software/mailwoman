/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The column groups every polygon layer's schema repeats, as schema-builder helpers — so the
 *   `WITHOUT ROWID`-versus-blob discipline is stated once, beside the columns it governs.
 */

import type { CreateTableBuilder, Kysely } from "kysely"

/**
 * The slice of a Kysely handle a schema module's DDL touches. Kysely is invariant in its schema parameter, so naming
 * only the member the builders call lets a caller pass its own wider handle.
 */
export type SchemaHandle<DB> = Pick<Kysely<DB>, "schema">

/**
 * The precomputed bounding box plus the unsimplified ring blob every polygon truth table carries.
 *
 * A table taking these stays a PLAIN rowid table, never `WITHOUT ROWID`: the `rings` blob is exactly the payload
 * clustering into the B-tree penalizes — every index page becomes a geometry page.
 */
export function addRingGeometryColumns<TB extends string, C extends string>(
	builder: CreateTableBuilder<TB, C>
): CreateTableBuilder<TB, C | "min_lat" | "min_lon" | "max_lat" | "max_lon" | "rings"> {
	return builder
		.addColumn("min_lat", "real", (column) => column.notNull())
		.addColumn("min_lon", "real", (column) => column.notNull())
		.addColumn("max_lat", "real", (column) => column.notNull())
		.addColumn("max_lon", "real", (column) => column.notNull())
		.addColumn("rings", "blob", (column) => column.notNull())
}

/**
 * The cell-index columns every polygon summary tier carries: the 48-bit short cell, the resolution it was captured at
 * (a short cell does not name its own, and a mixed-resolution table cannot be probed without it), the key the row
 * names, and its containment.
 *
 * Small fixed-width rows probed by their exact primary key are the `WITHOUT ROWID` shape — the caller adds its own
 * primary-key constraint and the raw `without rowid` modifier, because the key differs per layer.
 */
export function addCellIndexColumns<TB extends string, C extends string, K extends string>(
	builder: CreateTableBuilder<TB, C>,
	keyColumn: K
): CreateTableBuilder<TB, C | K | "h3_cell" | "resolution" | "containment"> {
	return builder
		.addColumn("h3_cell", "integer", (column) => column.notNull())
		.addColumn("resolution", "integer", (column) => column.notNull())
		.addColumn(keyColumn, "text", (column) => column.notNull())
		.addColumn("containment", "text", (column) => column.notNull())
}
