/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema for the polygon sidecar (`wof-polygons.db`) — the one table `WOFReverseGeocoder` probes for a
 *   place's geometry. The interface is the read/write contract and {@link createPolygonsTable} creates the table, so a
 *   column added to one is a compile error against the other.
 *
 *   The sidecar is OPTIONAL to the reverse geocoder: without it every result falls back to a centroid, so the reader
 *   checks for the table's presence rather than assuming it.
 */

import type { Kysely } from "kysely"

/**
 * One admin polygon, keyed by WOF id.
 */
export interface PolygonsTable {
	id: number
	/**
	 * The GeoJSON geometry, JSON-encoded. A row that fails to parse reads as no-polygon, never as an error — a malformed
	 * geometry must not fail the whole reverse query.
	 */
	geom: string
}

export interface PolygonDatabase {
	polygons: PolygonsTable
}

/**
 * The slice of a Kysely handle the polygon DDL touches. Kysely is invariant in its schema parameter, so naming only
 * `schema` lets a builder holding a wider handle pass it without a cast.
 */
export type PolygonSchemaHandle = Pick<Kysely<PolygonDatabase>, "schema">

/**
 * Create the `polygons` table — called before the streaming bulk load.
 */
export async function createPolygonsTable(db: PolygonSchemaHandle): Promise<void> {
	await db.schema
		.createTable("polygons")
		.addColumn("id", "integer", (column) => column.primaryKey())
		.addColumn("geom", "text", (column) => column.notNull())
		.execute()
}
