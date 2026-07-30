/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema for bdc.db — the FCC Broadband Data Collection availability read-side layer (2a
 *   decisions 4, 8). `bdc_availability` holds, in the default (non-`includeLocationIDs`) build mode, one
 *   row per DISTINCT (geoid, provider_id, technology_code, max_advertised_download_speed,
 *   max_advertised_upload_speed, low_latency, business_residential_code) tuple parsed from the FCC's
 *   per-provider CSV (see `sdk/parsing.ts`) — NOT one row per (block, provider, technology) triple: when
 *   two Broadband Serviceable Locations in the same block file different speeds/flags for the same
 *   provider/technology, both rows survive `build-bdc.ts`'s materialize-time collapse (see that file's
 *   docstring; accepted FCC filing behavior, not a bug). `bdc_provider` is a small dictionary
 *   keyed on `provider_id`, populated by a later registry-join task — decision 8 keeps FRN/brand/
 *   holding-company resolution out of 2a's scope. The DB also embeds the layer-contract tables from
 *   `@mailwoman/core/layers` (manifest tier `shipped`, license `public-domain` — FCC BDC block-level
 *   availability data, at the granularity this layer ships, is US government public-domain data, not
 *   redistribution-restricted; the CostQuest Fabric boundary this workspace never crosses is the
 *   licensing edge, see `bdc/README.md` — spine `h3` res 9 for availability rows, res 6 for coverage
 *   cells, matching poi.db's convention).
 *
 *   Clustering decision (implementer's pick — the brief allows either): a PLAIN rowid table, NOT
 *   `WITHOUT ROWID`, and NOT a composite `(h3_cell, provider_id, technology_code)` primary key.
 *   `WITHOUT ROWID` earns its keep on small, PK-probed rows — poi.db's clustered key and
 *   `layer_coverage`'s per-cell probe both read by their exact PK and nothing else, so folding the row
 *   into the B-tree removes a second lookup. `bdc_availability` doesn't fit that shape: it's a wider,
 *   10-column row read two different ways — an h3-range scan ("everything near this cell", the
 *   coverage/overlay path) and a geoid point lookup (the public spatial join key TIGER and callers
 *   actually probe by) — never a single composite-key point probe. Clustering the full row under a
 *   composite PK would also force the bulk loader to sort-then-insert in that exact key order across
 *   millions of rows spread over per-provider, per-state source files, for a locality win a plain
 *   index already delivers without constraining ingest order. So: a regular rowid table, an index on
 *   `h3_cell` bundled into {@link createBDCAvailabilityTable} (every reader depends on it, same as the
 *   table itself), and {@link createBDCGeoidIndex} as a separate, callable-after-bulk-load secondary
 *   index for the geoid path — the index-after-load discipline used elsewhere in this repo (see
 *   poi-schema.ts's name_key/brand indexes).
 */

import type { LayerContractDatabase } from "@mailwoman/core/layers"
import type { Kysely } from "kysely"

/**
 * One availability row from the FCC's per-provider BDC CSV. In the default build mode this is one row per DISTINCT
 * (geoid, provider_id, technology_code, speeds, low_latency, business_residential_code) tuple — NOT one row per (block,
 * provider, technology) triple; a triple whose BSLs carry differing speed tiers keeps multiple rows here (see
 * `build-bdc.ts`'s docstring).
 */
export interface BDCAvailabilityTable {
	/**
	 * Res-9 integer short H3 cell of the block centroid (spine).
	 */
	h3_cell: number
	/**
	 * 15-char census block GEOID (public spatial key).
	 */
	geoid: string
	/**
	 * Block-centroid PIP at build time (spine).
	 */
	wof_id: number | null
	provider_id: number
	technology_code: number
	max_advertised_download_speed: number
	max_advertised_upload_speed: number
	low_latency: 0 | 1
	business_residential_code: string
	/**
	 * Opaque BSL join key — NEVER resolved (spec §2.2); null unless `--include-location-ids`.
	 */
	location_id: string | null
}

/**
 * Provider dictionary keyed on `provider_id`. Populated by a later registry-join task (2a decision 8); no FK constraint
 * against `bdc_availability.provider_id` — SQLite doesn't enforce FKs without `PRAGMA foreign_keys`, and the join
 * happens at read time, not write time.
 */
export interface BDCProviderTable {
	/**
	 * PK.
	 */
	provider_id: number
	frn: string | null
	brand_name: string | null
	holding_company: string | null
}

export interface BDCDatabase extends LayerContractDatabase {
	bdc_availability: BDCAvailabilityTable
	bdc_provider: BDCProviderTable
}

/**
 * H3 resolution for `bdc_availability.h3_cell` — the block-centroid spine resolution.
 */
export const BDC_H3_RESOLUTION = 9

/**
 * H3 resolution for `layer_coverage.h3_cell` in bdc.db — coarser than the availability spine, matching poi.db's res-6
 * coverage-cell convention.
 */
export const BDC_COVERAGE_H3_RESOLUTION = 6

/**
 * Create `bdc_availability` as a plain rowid table, plus the `h3_cell` range-scan index (bundled here since every
 * reader depends on it — see the file header for the clustering rationale). Call {@link createBDCGeoidIndex}
 * separately, after bulk load, for the geoid point-lookup path.
 */
export async function createBDCAvailabilityTable(db: Kysely<BDCDatabase>): Promise<void> {
	await db.schema
		.createTable("bdc_availability")
		.addColumn("h3_cell", "integer", (c) => c.notNull())
		.addColumn("geoid", "text", (c) => c.notNull())
		.addColumn("wof_id", "integer")
		.addColumn("provider_id", "integer", (c) => c.notNull())
		.addColumn("technology_code", "integer", (c) => c.notNull())
		.addColumn("max_advertised_download_speed", "integer", (c) => c.notNull())
		.addColumn("max_advertised_upload_speed", "integer", (c) => c.notNull())
		.addColumn("low_latency", "integer", (c) => c.notNull())
		.addColumn("business_residential_code", "text", (c) => c.notNull())
		.addColumn("location_id", "text")
		.execute()

	await db.schema.createIndex("bdc_availability_h3_cell").on("bdc_availability").column("h3_cell").execute()
}

/**
 * Create `bdc_provider`. A single-column INTEGER PRIMARY KEY is already the SQLite rowid alias, so there's no `WITHOUT
 * ROWID` win here — that modifier only pays off clustering a composite or non-integer PK.
 */
export async function createBDCProviderTable(db: Kysely<BDCDatabase>): Promise<void> {
	await db.schema
		.createTable("bdc_provider")
		.addColumn("provider_id", "integer", (c) => c.primaryKey())
		.addColumn("frn", "text")
		.addColumn("brand_name", "text")
		.addColumn("holding_company", "text")
		.execute()
}

/**
 * Secondary index for the geoid point-lookup path (the public spatial join key). Call AFTER the bulk materialize
 * (index-after-load), same discipline as poi.db's secondary indexes.
 */
export async function createBDCGeoidIndex(db: Kysely<BDCDatabase>): Promise<void> {
	await db.schema.createIndex("bdc_availability_geoid").on("bdc_availability").column("geoid").execute()
}
