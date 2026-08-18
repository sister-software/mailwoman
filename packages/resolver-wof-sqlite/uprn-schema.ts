/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema for `uprn.db` — the OS Open UPRN spatial layer: every GB Unique Property Reference
 *   Number with its WGS84 point, so mailwoman results can carry UPRN as an interoperability key
 *   beside our own `@mailwoman/address-id`. One rowid table keyed `uprn INTEGER PRIMARY KEY` (the
 *   rowid alias — the optimal shape for an integer-PK point table; `WITHOUT ROWID` buys nothing
 *   here), plus a secondary res-9 `h3_cell` index for the bounded nearest-point probe.
 *
 *   ## Coordinates are OS's own WGS84 columns
 *
 *   The source CSV publishes BOTH coordinate systems per row — OSGB36 eastings/northings AND WGS84
 *   `LATITUDE`/`LONGITUDE`. This layer stores OS's own lat/lon verbatim and never reconverts from
 *   eastings: `@mailwoman/spatial`'s `osgb36ToWGS84` is a 7-parameter Helmert with a measured p95 of
 *   4.18 m, and re-deriving what the publisher already computed (with OSTN15, exactly) would replace
 *   their answer with a strictly worse one.
 *
 *   ## Why `h3_cell` exists at all
 *
 *   The layer contract requires every domain row to be addressable by at least one spine key —
 *   `writeLayerManifest` throws on a manifest that declares none — and UPRN is its own id space, not
 *   H3/WOF/address-id/street. The res-9 short cell (`shortCellToInt`, the same packing as poi.db and
 *   the OSM situs shards) is the spine that fits a point table, and its index doubles as the
 *   `nearestUPRN` ring probe.
 *
 *   The DB also embeds the layer-contract tables from `@mailwoman/core/layers`; the builder
 *   (`packages/mailwoman/gazetteer-pipeline/uprn-layer.ts`) writes the manifest and per-res-6-cell
 *   coverage.
 */

import type { LayerContractDatabase } from "@mailwoman/core/layers"
import { shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import { latLngToCell } from "h3-js"
import type { Kysely } from "kysely"

/**
 * Resolution the `uprn` table's `h3_cell` column is keyed at — the shared layer-spine resolution (poi.db, the OSM situs
 * shards).
 */
export const UPRN_H3_RESOLUTION = 9

/**
 * Resolution of the layer's `layer_coverage` cells — coarse, per the contract (matches poi.db).
 */
export const UPRN_COVERAGE_H3_RESOLUTION = 6

/**
 * One UPRN point. `uprn` is the rowid alias, so the primary probe (`coordinateOf`) is a rowid B-tree hit.
 */
export interface UPRNTable {
	/**
	 * The Unique Property Reference Number — up to 12 digits, so always within `Number.MAX_SAFE_INTEGER`.
	 */
	uprn: number
	/**
	 * WGS84 latitude, as OS published it (never reconverted from eastings — see the module docstring).
	 */
	lat: number
	/**
	 * WGS84 longitude, as OS published it.
	 */
	lon: number
	/**
	 * 48-bit short H3 cell at {@link UPRN_H3_RESOLUTION} (`uprnH3Cell`) — the layer-contract spine key and the
	 * `nearestUPRN` probe index.
	 */
	h3_cell: number
}

/**
 * Build-provenance key/value pairs the fixed `layer_manifest` columns have no room for: quality-drop counts, the header
 * as found, the upstream licence text verbatim (the Code-Point provenance discipline).
 */
export interface UPRNMetaTable {
	key: string
	value: string
}

export interface UPRNDatabase extends LayerContractDatabase {
	uprn: UPRNTable
	uprn_meta: UPRNMetaTable
}

/**
 * The full res-9 cell for a UPRN point — the ONE derivation both the builder and every consumer share, so a fixture
 * built by a test and a row built by the real ingest can never disagree on which cell a coordinate keys to.
 */
export function uprnFullCell(latitude: number, longitude: number): H3Cell {
	return latLngToCell(latitude, longitude, UPRN_H3_RESOLUTION) as H3Cell
}

/**
 * The `h3_cell` column value for a UPRN point: {@link uprnFullCell} packed to the shared 48-bit short-cell integer.
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
 * Secondary index for the `nearestUPRN` ring probe. Builders call this AFTER the bulk load (index-after-load).
 */
export async function createUPRNIndexes(db: Kysely<UPRNDatabase>): Promise<void> {
	await db.schema.createIndex("uprn_h3_cell").on("uprn").column("h3_cell").execute()
}
