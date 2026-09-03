/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema for `nsul.db` — the GB UPRN → unit-postcode register: the ONS **National Statistics
 *   UPRN Lookup** (NSUL) joined to the WGS84 point OS Open UPRN publishes for the same UPRN. One row per
 *   GB UPRN that carries a unit postcode AND has a published coordinate; the postcode is Code-Point
 *   Open's, so this table and `postcode-gb.bin` agree by construction on the universe of unit postcodes.
 *
 *   ## Why this table exists
 *
 *   Code-Point Open gives one coordinate per unit postcode; Open UPRN gives one coordinate per
 *   addressable object; neither says which object carries which postcode. NSUL does, as field `PCDS`,
 *   under OGL-UK-3.0. The `PO`-area measurement that produced this design (recorded on #1975) showed a
 *   nearest-centroid reconstruction of the register is exact on 69.6% of 531,266 UPRNs and a building
 *   footprint adds nothing, so the register is stored rather than inferred.
 *
 *   ## Shape
 *
 *   `uprn_postcode` is `WITHOUT ROWID` keyed on the UPRN: small fixed rows, probed by primary key, with
 *   one secondary index on `pcds_compact`. The postcode is stored twice on purpose — `pcds` exactly as
 *   NSUL writes it (`RG40 4HR`, one space) and `pcds_compact` with the space removed (`RG404HR`), which
 *   is the form Code-Point Open's `spr.name` uses, so the two artifacts join on a column rather than an
 *   expression. `lat`/`lon`/`h3_cell` are COPIED from `uprn.db` at build time by UPRN join — OS's own
 *   WGS84 columns, never a reprojection of NSUL's `GRIDGB1E`/`GRIDGB1N` — so a coordinate here is
 *   byte-identical to the one `uprn.db` holds for the same UPRN.
 *
 *   The DB also embeds the layer-contract tables from `@mailwoman/core/layers`; the builder
 *   (`packages/mailwoman/lib/gazetteer-pipeline/nsul-layer.ts`) writes the manifest and coverage.
 */

import type { LayerContractDatabase } from "@mailwoman/core/layers"
import { sql, type Kysely } from "kysely"

/**
 * Resolution of the `h3_cell` column — the same res-9 spine `uprn.db` keys on, because the value is copied from it.
 */
export const NSUL_H3_RESOLUTION = 9

/**
 * Resolution of the layer's `layer_coverage` cells — coarse, per the contract, and the same as `uprn.db`'s so the two
 * layers' coverage tables describe the same cells.
 */
export const NSUL_COVERAGE_H3_RESOLUTION = 6

/**
 * One UPRN with its unit postcode and the point OS publishes for it.
 */
export interface UPRNPostcodeTable {
	/**
	 * The Unique Property Reference Number — up to 12 digits, so always within `Number.MAX_SAFE_INTEGER`.
	 */
	uprn: number
	/**
	 * The unit postcode as NSUL writes it — outward code, one space, inward code (`RG40 4HR`).
	 */
	pcds: string
	/**
	 * {@link pcds} with the space removed (`RG404HR`) — the form Code-Point Open's `spr.name` carries, and the column
	 * `uprnsForPostcode` probes.
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
 * Build-provenance key/value pairs the fixed `layer_manifest` columns have no room for: the accounting counts, the
 * header as found, the per-region row counts, the four attribution lines.
 */
export interface NSULMetaTable {
	key: string
	value: string
}

export interface NSULDatabase extends LayerContractDatabase {
	uprn_postcode: UPRNPostcodeTable
	nsul_meta: NSULMetaTable
}

/**
 * The compact form of a unit postcode: every space removed, upper-cased. `RG40 4HR` → `RG404HR`. The ONE derivation
 * both the builder and every consumer share, so a caller holding NSUL's spaced form and one holding Code-Point's
 * compact form reach the same key.
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
 * The `pcds_compact` index the `uprnsForPostcode` probe reads. Builders call this AFTER the bulk load
 * (index-after-load). There is no index on the spaced `pcds`: it is derivable from `pcds_compact` through
 * {@link compactPostcode}, and a second index over 40 million rows would buy nothing a caller cannot get by compacting
 * its key first.
 */
export async function createNSULIndexes(db: Kysely<NSULDatabase>): Promise<void> {
	await db.schema.createIndex("uprn_postcode_pcds_compact").on("uprn_postcode").column("pcds_compact").execute()
}
